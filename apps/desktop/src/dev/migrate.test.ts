import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { nodeConn } from "./conn";
import { catchUp, migrationList } from "./migrate";

describe("the preview database catches up with new migrations (F65-new)", () => {
  it("applies only what an older database is missing", () => {
    const list = migrationList();
    const last = list[list.length - 1];
    if (!last) throw new Error("no migrations");
    const c = nodeConn(openTestDb({ migrate: false }));
    // An older dev-data/sirna.db: every migration but the newest.
    expect(catchUp(c, list.slice(0, -1), 1)).toHaveLength(list.length - 1);
    expect(catchUp(c, list, 2)).toEqual([last.name]);
    expect(catchUp(c, list, 3)).toEqual([]);
  });

  it("has money_accounts.checked_at after catching up", () => {
    const c = nodeConn(openTestDb({ migrate: false }));
    catchUp(c);
    expect(() => c.all("SELECT checked_at FROM money_accounts")).not.toThrow();
  });
});
