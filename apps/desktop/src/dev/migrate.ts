/**
 * Dev-only: brings the preview database up to the current schema when it is
 * loaded (F65-new). A dev-data/sirna.db built before a new migration (or a
 * snapshot stored before it) would otherwise fail with "no such column"
 * until someone ran scripts/preview-db.mjs again. Rust does the same on app
 * start (migrate.rs), from the same files.
 */
import { type Conn } from "./conn";

const files = import.meta.glob<string>("/src/**/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Migrations by file name (`0001_…`), as src/test/sqlite.ts orders them. */
export function migrationList(): { name: string; sql: string }[] {
  return Object.entries(files)
    .map(([path, sql]) => ({
      name:
        path
          .split("/")
          .pop()
          ?.replace(/\.sql$/, "") ?? path,
      sql,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Applies the migrations the database hasn't had; returns their names. */
export function catchUp(conn: Conn, list = migrationList(), now: number = Date.now()): string[] {
  conn.exec(
    "CREATE TABLE IF NOT EXISTS core_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(conn.all("SELECT name FROM core_migrations").map((row) => String(row.name)));
  const applied: string[] = [];
  for (const migration of list) {
    if (done.has(migration.name)) continue;
    conn.exec(migration.sql);
    conn.run("INSERT INTO core_migrations (name, checksum, applied_at) VALUES (?, 'preview', ?)", [
      migration.name,
      now,
    ]);
    applied.push(migration.name);
  }
  return applied;
}
