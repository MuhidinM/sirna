// `pnpm ship`: build the release installer, install it over the running app,
// and start it in the tray (plan §11). Toasts, the tray and the hotkey only
// behave correctly in the installed build, so every milestone ends here.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

const MIN_FREE_GB = 3;
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "apps/desktop/src-tauri/target");
const installDir = join(process.env.LOCALAPPDATA ?? "", "Sirna");

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

function mb(bytes) {
  return (bytes / 1024 ** 2).toFixed(1);
}

function dirSize(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(dir, entry.name);
    return sum + (entry.isDirectory() ? dirSize(path) : statSync(path).size);
  }, 0);
}

// 1. Refuse to build when the build disk is nearly full (plan §10 floors).
const disk = statfsSync(targetDir.slice(0, 3));
const freeBytes = disk.bavail * disk.bsize;
if (freeBytes < MIN_FREE_GB * 1024 ** 3) {
  console.error(
    `Only ${gb(freeBytes)} GB free on ${targetDir.slice(0, 2)}; need ${MIN_FREE_GB} GB. Run cargo clean first.`,
  );
  process.exit(1);
}

// 2. Build the release installer.
execFileSync("pnpm", ["--filter", "@sirna/desktop", "tauri", "build"], {
  stdio: "inherit",
  shell: true,
});

const bundleDir = join(targetDir, "release/bundle/nsis");
const installer = readdirSync(bundleDir)
  .filter((name) => name.endsWith("-setup.exe"))
  .map((name) => join(bundleDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!installer) {
  console.error(`No installer found in ${bundleDir}`);
  process.exit(1);
}

// 3. Quit the running app, then install silently over it.
try {
  execFileSync("taskkill", ["/IM", "sirna.exe", "/F"], { stdio: "ignore" });
} catch {
  // Not running.
}
execFileSync(installer, ["/S"], { stdio: "inherit" });

// 4. Start the installed app in the tray.
const exe = join(installDir, "sirna.exe");
if (!existsSync(exe)) {
  console.error(`Installed app not found at ${exe}`);
  process.exit(1);
}
// `start` fully detaches it, so it outlives this script and the terminal.
spawn("cmd", ["/c", "start", '""', `"${exe}"`, "--autostart"], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  windowsVerbatimArguments: true,
}).unref();

console.log(`Installed ${installer}`);
console.log(
  `Installer: ${mb(statSync(installer).size)} MB · installed: ${mb(dirSize(installDir))} MB`,
);
