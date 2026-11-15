// Builds public/__ref/sirna.db for the browser preview (src/dev/tauriPreview.ts):
// a copy of a backup (or an empty database), all migrations, and demo data
// dated around today so every page has something to show. Never committed.
//
//   node scripts/preview-db.mjs [backup.db]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const OUT = "public/__ref/sirna.db";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
if (process.argv[2]) fs.copyFileSync(process.argv[2], OUT);
const db = new DatabaseSync(OUT);
db.exec(
  "CREATE TABLE IF NOT EXISTS core_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
);

// Migrations, the same set as src/test/sqlite.ts.
const done = new Set(
  db
    .prepare("SELECT name FROM core_migrations")
    .all()
    .map((r) => r.name),
);
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\/migrations\/\d{4}_[^/]+\.sql$/.test(p.replaceAll("\\", "/"))) files.push(p);
  }
})("src");
files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
for (const file of files) {
  const name = path.basename(file, ".sql");
  if (done.has(name)) continue;
  db.exec(fs.readFileSync(file, "utf8"));
  db.prepare(
    "INSERT INTO core_migrations (name, checksum, applied_at) VALUES (?, 'preview', ?)",
  ).run(name, Date.now());
  console.log("applied", name);
}

// --- Demo data ---------------------------------------------------------------------
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
// Logical date in Addis (UTC+3, day starts 03:00).
const logical = (ms) => new Date(ms + 3 * HOUR - 3 * HOUR).toISOString().slice(0, 10);
const today = logical(now);
const shift = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const at = (date, hh, mm = 0) => Date.parse(`${date}T00:00:00Z`) + (hh - 3) * HOUR + mm * 60_000;
let seq = 0;
const id = (p) => `demo_${p}_${++seq}`;
const run = (sql, ...args) => db.prepare(sql).run(...args);
const has = (table) =>
  db.prepare(`SELECT count(*) n FROM ${table} WHERE id LIKE 'demo_%'`).get().n > 0;

if (!has("task_items")) {
  const task = (title, extra = {}) => {
    const row = {
      id: id("t"),
      title,
      status: "todo",
      area_id: null,
      due_date: null,
      estimate_min: null,
      project_id: null,
      created_at: now - 5 * DAY,
      updated_at: now - DAY,
      ...extra,
    };
    const cols = Object.keys(row);
    run(
      `INSERT INTO task_items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      ...cols.map((c) => row[c]),
    );
    return row.id;
  };
  const project = (title, area, deadline, weekly, extra = {}) => {
    const pid = id("p");
    run(
      "INSERT INTO project_items (id, title, area_id, goal, estimate_min, deadline, weekly_min, start_date, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      pid,
      title,
      area,
      extra.goal ?? null,
      extra.estimate ?? 1200,
      deadline,
      weekly,
      shift(today, -14),
      extra.status ?? "active",
      now - 14 * DAY,
      now - DAY,
    );
    return pid;
  };
  const portfolio = project("Portfolio site", "coding", shift(today, 24), 240, {
    goal: "Three case studies live",
  });
  const apps = project("Apply to 10 backend roles", "jobhunt", shift(today, 10), 180);
  project("Learn Rust async", "coding", shift(today, 60), 120, { status: "idea" });
  task("Send weekly report to Job A", { area_id: "joba", due_date: today, estimate_min: 30 });
  task("Write About page copy", {
    area_id: "coding",
    project_id: portfolio,
    due_date: today,
    estimate_min: 60,
  });
  task("Apply: Backend dev at Kifiya", {
    area_id: "jobhunt",
    project_id: apps,
    due_date: shift(today, 1),
    estimate_min: 45,
  });
  task("Fix login bug on staging", {
    area_id: "jobb",
    due_date: shift(today, 2),
    estimate_min: 90,
  });
  task("Renew residence ID", { area_id: "admin", due_date: shift(today, 4), estimate_min: 60 });
  task("Case study: Sirna", {
    area_id: "coding",
    project_id: portfolio,
    due_date: shift(today, 6),
    estimate_min: 120,
  });
  task("Call the landlord about the water", { area_id: "admin", estimate_min: 15 });
  task("Read chapter 4 of Rust book", { area_id: "coding", estimate_min: 40 });
  task("Gym: legs day", {
    area_id: "gym",
    status: "done",
    completed_at: now - 2 * HOUR,
    due_date: today,
  });
  task("Reply to Hana about the API", {
    area_id: "jobb",
    status: "waiting",
    waiting_on: "Hana",
    follow_up_date: shift(today, 1),
  });
  task("Pick a hosting plan", {
    area_id: "coding",
    project_id: portfolio,
    status: "done",
    completed_at: now - DAY,
  });
  // Today's top 3.
  const top = db
    .prepare(
      "SELECT id FROM task_items WHERE id LIKE 'demo_%' AND due_date = ? AND status = 'todo' LIMIT 3",
    )
    .all(today);
  top.forEach((row, i) =>
    run(
      "INSERT OR REPLACE INTO task_daily_top (logical_date, position, task_id, chosen_by, created_at, updated_at) VALUES (?,?,?, 'user', ?, ?)",
      today,
      i + 1,
      row.id,
      now,
      now,
    ),
  );
}

if (!has("note_items")) {
  const note = (kind, status, title, body) =>
    run(
      "INSERT INTO note_items (id, kind, status, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      id("n"),
      kind,
      status,
      title,
      body,
      now - DAY,
      now - DAY,
    );
  note("inbox", "inbox", null, "look into a standing desk");
  note("inbox", "inbox", null, "idea: weekly money summary on Sunday");
  note("inbox", "inbox", null, "ask Abel about the meetup");
  note("cheat", "kept", "git reset", "git reset --soft HEAD~1 keeps the changes staged");
  note("cheat", "kept", "Docker prune", "docker system prune -a --volumes");
  note("idea", "kept", "Habit tracker for the gym", "Count sessions per week and show a streak.");
}

if (!has("money_txns")) {
  const txn = (date, minor, what, cat, account = "cash", extra = {}) =>
    run(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, currency, description, category_id, origin, created_at, updated_at, area_id) VALUES (?,?,?,?,?, 'ETB', ?,?, 'preview', ?, ?, ?)",
      id("m"),
      account,
      at(date, 12),
      date,
      minor,
      what,
      cat,
      at(date, 12),
      at(date, 12),
      extra.area ?? null,
    );
  run(
    "UPDATE money_accounts SET opening_minor = ?, opening_date = ? WHERE id = 'cbo'",
    4_250_000,
    shift(today, -40),
  );
  run(
    "UPDATE money_accounts SET opening_minor = ?, opening_date = ? WHERE id = 'cash'",
    320_000,
    shift(today, -40),
  );
  run(
    "UPDATE money_accounts SET opening_minor = ?, opening_date = ? WHERE id = 'telebirr'",
    85_000,
    shift(today, -40),
  );
  for (let d = 35; d >= 0; d--) {
    const date = shift(today, -d);
    if (d % 1 === 0) txn(date, -(9_000 + ((d * 37) % 9) * 1_000), "lunch", "cat_food");
    if (d % 3 === 0) txn(date, -(4_000 + ((d * 13) % 5) * 1_000), "taxi", "cat_transport");
    if (d % 6 === 0)
      txn(date, -(25_000 + ((d * 7) % 4) * 10_000), "groceries", "cat_food", "telebirr");
    if (d % 9 === 0) txn(date, -45_000, "coffee beans", "cat_food");
  }
  const monthStart = `${today.slice(0, 7)}-01`;
  txn(shift(monthStart, 0), -1_200_000, "rent", "cat_housing", "cbo");
  txn(shift(monthStart, 4), -120_000, "internet", "cat_phone", "telebirr");
  txn(shift(monthStart, 9), 2_800_000, "salary", "cat_salary", "cbo", { area: "joba" });
  if (today >= shift(monthStart, 20))
    txn(shift(monthStart, 20), 1_900_000, "salary", "cat_salary", "cbo", { area: "jobb" });
  txn(shift(monthStart, -31 + 9), 2_800_000, "salary", "cat_salary", "cbo", { area: "joba" });
  txn(shift(monthStart, -31 + 20), 1_900_000, "salary", "cat_salary", "cbo", { area: "jobb" });
  txn(shift(today, -6), -350_000, "shoes", "cat_shopping", "cbe");
  const reg = (kind, name, minor, day, cat, area = null) =>
    run(
      "INSERT INTO money_regulars (id, kind, name, amount_minor, rule_json, category_id, account, area_id, active, created_at, updated_at) VALUES (?,?,?,?,?,?, 'cbo', ?, 1, ?, ?)",
      id("r"),
      kind,
      name,
      minor,
      JSON.stringify({ every: "month", day }),
      cat,
      area,
      now - 40 * DAY,
      now - 40 * DAY,
    );
  reg("bill", "Rent", 1_200_000, 1, "cat_housing");
  reg("bill", "Internet", 120_000, 5, "cat_phone");
  reg("bill", "Iddir", 20_000, Number(shift(today, 1).slice(8, 10)), "cat_family");
  reg("pay", "Job A pay", 2_800_000, 10, "cat_salary", "joba");
  reg("pay", "Job B pay", 1_900_000, 21, "cat_salary", "jobb");
  const loan = (person, kind, minor, date) =>
    run(
      "INSERT INTO money_loans (id, person, kind, amount_minor, local_date, account, created_at, updated_at) VALUES (?,?,?,?,?, 'cash', ?, ?)",
      id("l"),
      person,
      kind,
      minor,
      date,
      now,
      now,
    );
  loan("Abel", "lent", 150_000, shift(today, -12));
  loan("Abel", "paid_me", 50_000, shift(today, -3));
  loan("Selam", "borrowed", 80_000, shift(today, -8));
  run("UPDATE money_categories SET cap_minor = 450000 WHERE id = 'cat_food'");
  run("UPDATE money_categories SET cap_minor = 150000 WHERE id = 'cat_transport'");
}

if (!has("savings_goals")) {
  const goal = id("g");
  run(
    "INSERT INTO savings_goals (id, title, target_minor, start_date, status, created_at, updated_at, target_date) VALUES (?,?,?,?, 'active', ?, ?, ?)",
    goal,
    "Laptop",
    9_000_000,
    shift(today, -60),
    now - 60 * DAY,
    now,
    shift(today, 120),
  );
  for (const [d, minor] of [
    [-55, 1_500_000],
    [-40, 1_000_000],
    [-25, 2_000_000],
    [-10, 1_100_000],
  ])
    run(
      "INSERT INTO savings_entries (id, goal_id, occurred_at, local_date, amount_minor, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      id("s"),
      goal,
      at(shift(today, d), 12),
      shift(today, d),
      minor,
      now,
      now,
    );
}

db.exec("PRAGMA journal_mode=DELETE");
console.log("preview db ready:", OUT, "today", today);
