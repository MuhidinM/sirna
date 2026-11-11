import { DatabaseSync } from "node:sqlite";

/**
 * An in-memory SQLite database for tests, opened with the same pragmas the app
 * uses (plan §5.1). Migrations are applied here once the runner exists (T-012).
 */
export function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
