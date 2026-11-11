// pnpm usage [days]: what Sirna was used for, from the local database only
// (plan §1: usage steers what to build next; nothing leaves the machine).
// Read-only. SIRNA_DATA_DIR points it at another data folder.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const days = Number(process.argv[2] ?? 7);
const dir = process.env.SIRNA_DATA_DIR ?? join(process.env.APPDATA ?? "", "dev.sirna.app");
const db = new DatabaseSync(join(dir, "sirna.db"), { readOnly: true });

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// Logical days start at 03:00 in Addis Ababa (UTC+3), i.e. 00:00 UTC.
const today = new Date(Date.now()).toISOString().slice(0, 10);
const sinceMs = Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY;
const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);

const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) ?? {})[0] ?? 0;
const all = (sql, ...args) => db.prepare(sql).all(...args);

const rows = [
  [
    "Captures",
    one(
      "SELECT count(*) FROM core_raw_items WHERE source = 'capture' AND received_at >= ?",
      sinceMs,
    ),
  ],
  [
    "  undone",
    one(
      "SELECT count(*) FROM core_raw_items WHERE source = 'capture' AND parse_status = 'ignored' AND received_at >= ?",
      sinceMs,
    ),
  ],
  [
    "Tasks done",
    one("SELECT count(*) FROM task_items WHERE status = 'done' AND completed_at >= ?", sinceMs),
  ],
  [
    "Focus sessions completed",
    one(
      "SELECT count(*) FROM focus_sessions WHERE kind = 'focus' AND outcome = 'completed' AND started_at >= ?",
      sinceMs,
    ),
  ],
  [
    "  stopped early",
    one(
      "SELECT count(*) FROM focus_sessions WHERE kind = 'focus' AND outcome = 'stopped' AND started_at >= ?",
      sinceMs,
    ),
  ],
  [
    "  focused hours",
    (
      one(
        "SELECT COALESCE(SUM(MAX(0, ended_at - started_at - paused_ms)), 0) FROM focus_sessions WHERE kind = 'focus' AND ended_at IS NOT NULL AND started_at >= ?",
        sinceMs,
      ) / HOUR
    ).toFixed(1),
  ],
  [
    "  past the daily cap",
    one("SELECT count(*) FROM focus_sessions WHERE overrun = 1 AND started_at >= ?", sinceMs),
  ],
  [
    "Night reviews done",
    one("SELECT count(*) FROM day_reviews WHERE status = 'done' AND logical_date >= ?", sinceDate),
  ],
  [
    "  skipped",
    one(
      "SELECT count(*) FROM day_reviews WHERE status = 'skipped' AND logical_date >= ?",
      sinceDate,
    ),
  ],
  [
    "  average energy (1-3)",
    Number(
      one(
        "SELECT COALESCE(AVG(energy), 0) FROM day_reviews WHERE energy IS NOT NULL AND logical_date >= ?",
        sinceDate,
      ),
    ).toFixed(1),
  ],
  [
    "Spending lines",
    one(
      "SELECT count(*) FROM money_txns WHERE deleted_at IS NULL AND amount_minor < 0 AND local_date >= ?",
      sinceDate,
    ),
  ],
  [
    "Cheat lines added",
    one(
      "SELECT count(*) FROM note_items WHERE kind = 'cheat' AND deleted_at IS NULL AND created_at >= ?",
      sinceMs,
    ),
  ],
];

console.log(`Sirna usage, last ${days} days (since ${sinceDate})\n`);
for (const [label, value] of rows) console.log(`${label.padEnd(28)} ${value}`);

const toasts = all(
  `SELECT kind, COALESCE(outcome, 'no answer') AS outcome, count(*) AS n FROM core_notifications
   WHERE fired_at >= ? GROUP BY kind, outcome ORDER BY kind, n DESC`,
  sinceMs,
);
if (toasts.length > 0) {
  console.log("\nToasts (kind · answer · count)");
  for (const t of toasts) console.log(`  ${t.kind.padEnd(10)} ${t.outcome.padEnd(11)} ${t.n}`);
}
