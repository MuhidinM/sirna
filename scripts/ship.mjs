// `pnpm ship`: build the release installer, install it over the running app,
// and start it in the tray (plan §11). Toasts, the tray and the hotkey only
// behave correctly in the installed build, so every milestone ends here.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// 3. Quit the running app, install silently over it and start it in the tray.
// This runs through the desktop shell (explorer): started from a packaged app
// such as the Claude desktop app, the installer would otherwise land in that
// app's private copy of AppData, out of sight of the Start menu and autostart.
// The script reports back in a status file: the installer's exit code, then
// the installed size as cmd sees it (Node may be shown the private copy).
const exe = join(installDir, "sirna.exe");
const script = join(tmpdir(), `sirna-install-${process.pid}.cmd`);
const status = `${script}.status`;
writeFileSync(
  script,
  [
    "@echo off",
    "setlocal",
    "taskkill /IM sirna.exe /F >nul 2>&1",
    // Give Windows a moment to release the old exe before overwriting it.
    "ping -n 2 127.0.0.1 >nul",
    `"${installer}" /S`,
    "set code=%ERRORLEVEL%",
    `if not exist "${exe}" set code=missing`,
    "set bytes=0",
    `for %%F in ("${installDir}\\*") do set /a bytes+=%%~zF`,
    `if "%code%"=="0" start "" "${exe}" --autostart`,
    `(echo %code%& echo %bytes%) > "${status}"`,
    'del "%~f0"',
    "",
  ].join("\r\n"),
);
try {
  execFileSync("explorer.exe", [script]);
} catch {
  // explorer.exe exits with 1 even when it ran the file.
}
const deadline = Date.now() + 180_000;
while (!existsSync(status) || existsSync(script)) {
  if (Date.now() > deadline) {
    console.error(`Install did not report back in 3 minutes (${script})`);
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
const [code, bytes] = readFileSync(status, "utf8").trim().split(/\s+/);
rmSync(status, { force: true });
if (code !== "0") {
  console.error(
    code === "missing"
      ? `Installed app not found at ${exe}`
      : `Installer failed with exit code ${code}`,
  );
  process.exit(1);
}

console.log(`Installed ${installer}`);
console.log(`Installer: ${mb(statSync(installer).size)} MB · installed: ${mb(Number(bytes))} MB`);
