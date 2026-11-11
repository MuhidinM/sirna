import { DatabaseSync } from "node:sqlite";

/**
 * Every `migrations/NNNN_name.sql` file under src, the same set the Rust
 * build embeds (src-tauri/build.rs), so tests and the app share one schema.
 */
const migrationFiles = import.meta.glob<string>("/src/**/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export interface Migration {
  name: string;
  sql: string;
}

/** Migrations ordered by their file name (`0001_…`, `0002_…`). */
export function migrations(): Migration[] {
  return Object.entries(migrationFiles)
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

/**
 * An in-memory SQLite database for tests, with the app's pragmas (plan §5.1)
 * and, unless `migrate` is false, every migration applied.
 */
export function openTestDb({ migrate = true }: { migrate?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  if (migrate) {
    for (const migration of migrations()) db.exec(migration.sql);
  }
  return db;
}
