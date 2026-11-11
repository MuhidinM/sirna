import { describe, expect, it } from "vitest";

import { migrations, openTestDb } from "./sqlite";

describe("openTestDb", () => {
  it("opens an in-memory database with foreign keys on", () => {
    const db = openTestDb();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("gives each test its own database", () => {
    const first = openTestDb({ migrate: false });
    first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const second = openTestDb({ migrate: false });
    const tables = second.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables).toEqual([]);
  });

  it("applies the app's migrations", () => {
    const db = openTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toContain("core_raw_items");
  });
});

describe("migrations", () => {
  it("are numbered 0001, 0002, … with no gaps or repeats", () => {
    const numbers = migrations().map((migration) => Number(migration.name.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});
