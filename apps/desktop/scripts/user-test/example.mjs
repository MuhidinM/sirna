// Example user test: two captures, Today at 09:30, a focus session on the
// current block, 30 minutes later, and the focus_sessions rows it wrote.
//
//   pnpm --dir apps/desktop dev                      (in another terminal)
//   node apps/desktop/scripts/user-test/example.mjs [YYYY-MM-DD] [--headed]
import { addisToday, launch } from "./sirna.mjs";

const args = process.argv.slice(2);
const date = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? addisToday();
const app = await launch({ headless: !args.includes("--headed") });

try {
  // Today at 09:30, from a fresh copy of dev-data/sirna.db.
  const main = await app.openMain({ now: `${date}T09:30`, fresh: true });

  for (const line of ["update the abc ui for job a at 10am", "lunch 120"]) {
    const { chip, echo } = await app.capture(line);
    console.log(`capture "${line}"\n  chip: ${chip}\n  echo: ${echo}`);
  }

  const [task] = await app.query(
    "SELECT title, area_id, due_date, due_at FROM task_items WHERE title LIKE 'update the abc ui%' AND deleted_at IS NULL",
  );
  console.log("task row:", JSON.stringify(task));

  await main.reload();
  console.log("screenshot:", await app.screenshot(main, "today-0930"));

  const sheet = await app.openFocusSheet();
  console.log(
    "sheet:",
    (await sheet.locator("#setup-title").textContent())?.trim(),
    "·",
    await sheet.locator("#setup-minutes").textContent(),
  );
  console.log("screenshot:", await app.screenshot(sheet, "focus-sheet"));
  const started = await app.startFocus(sheet, { intent: "first pass at the abc ui" });
  console.log("focus started:", started.started, started.message ?? "");
  console.log(
    "focus status:",
    JSON.stringify(await main.evaluate(() => globalThis.__sirna.focus())),
  );

  await app.advance(30);
  console.log("now:", await app.now());
  console.log("screenshot:", await app.screenshot(app.main ?? main, "today-1000-focus"));

  const rows = await app.query(
    `SELECT id, kind, block_id, area_id, started_at, planned_min, paused_ms, ended_at, outcome, intent_text
     FROM focus_sessions WHERE started_at >= ? ORDER BY started_at, kind DESC`,
    [Date.parse(`${date}T09:30:00+03:00`)],
  );
  const time = (ms) =>
    ms == null ? null : new Date(ms + 3 * 3_600_000).toISOString().slice(11, 16);
  console.log("focus_sessions:");
  console.table(
    rows.map((row) => ({ ...row, started_at: time(row.started_at), ended_at: time(row.ended_at) })),
  );

  console.log(
    "toasts:",
    JSON.stringify(
      (await app.anyPage().then((page) => page.evaluate(() => globalThis.__sirna.toasts))).map(
        (toast) => toast.title,
      ),
    ),
  );

  const errors = app.consoleErrors();
  console.log(
    errors.length
      ? `console errors:\n${errors.map((e) => `  [${e.page}] ${e.text}`).join("\n")}`
      : "console errors: none",
  );
} finally {
  await app.close();
}
