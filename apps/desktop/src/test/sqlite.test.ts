import { describe, expect, it } from "vitest";

import { openTestDb } from "./sqlite";

describe("openTestDb", () => {
  it("opens an in-memory database with foreign keys on", () => {
    const db = openTestDb();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("gives each test its own empty database", () => {
    const first = openTestDb();
    first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const second = openTestDb();
    const tables = second.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables).toEqual([]);
  });
});
