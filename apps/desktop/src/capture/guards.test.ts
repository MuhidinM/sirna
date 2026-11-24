/** Undo and Up-fix guards found in the second recheck (reg2-1, reg2-2, reg2-5, reg2-6, reg2-7). */
import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { nodeConn } from "../dev/conn";
import {
  AWAY_KEY,
  captureCommit,
  captureUndo,
  clearAway,
  setAway,
  settingString,
} from "../dev/commands";
import { applyOps, type Op } from "../dev/tx";
import { loanOps } from "../features/money/loans";
import { editOps, groupCards, CHEAT_SQL, type CheatRow } from "../features/notes/cheat";
import {
  type BlockRow,
  LAST_CAPTURE_SQL,
  type LastCapture,
  UNDO_BLOCKED_SQL,
  undoBlocked,
} from "./fix";
import { TODAY_PARSER, TODAY_PARSER_ID, todayTask } from "./today";

const T = Date.parse("2026-11-24T09:30:00+03:00");

function setup() {
  const c = nodeConn(openTestDb());
  const blocked = (raw: number, verb: "undo" | "fix" = "undo") =>
    undoBlocked(c.all(UNDO_BLOCKED_SQL, [`capture:${raw}`]) as unknown as BlockRow[], verb);
  return { c, blocked };
}

describe("a block capture and a later move of that block (reg2-1)", () => {
  it("won't undo 'skipped quran' over a move you made since", () => {
    const { c, blocked } = setup();
    const two = (n: number) => String(n).padStart(2, "0");
    const at = (h: number, m: number) => Date.parse(`2026-11-24T${two(h)}:${two(m)}:00+03:00`);
    c.run(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, created_at, updated_at) VALUES ('q', '2026-11-24', ?, ?, 'routine', 'Quran', 0, 0)",
      [at(6, 0), at(6, 20)],
    );
    const skip: Op = { op: "update", table: "day_blocks", id: "q", values: { status: "skipped" } };
    const raw = captureCommit(c, { rawText: "skipped quran", ops: [skip] }, T).result;
    expect(blocked(raw)).toBeNull();
    applyOps(
      c,
      "user",
      null,
      [
        {
          op: "update",
          table: "day_blocks",
          id: "q",
          values: { start_at: at(6, 30), end_at: at(6, 50) },
        },
      ],
      T + 1,
    );
    expect(blocked(raw)).toBe("You've changed this block since. Edit it on Today.");
    expect(blocked(raw, "fix")).toBe("You've changed this block since. Edit it on Today.");
    expect(() => captureUndo(c, { rawId: raw }, T + 2)).toThrow(/changed this block since/);
    expect(c.all("SELECT status, start_at FROM day_blocks")).toEqual([
      { status: "skipped", start_at: at(6, 30) },
    ]);
  });
});

describe("a loan with a later repayment (reg2-2)", () => {
  const loan = (person: string, kind: "lent" | "paid_me", amount: number, id: string) =>
    loanOps({
      person,
      kind,
      amount,
      date: "2026-11-24",
      account: "cash",
      nowMs: T,
      id,
      txnId: `${id}-txn`,
    });

  it("won't undo 'lent zelalem 800' once Zelalem paid some back on Money", () => {
    const { c, blocked } = setup();
    const raw = captureCommit(
      c,
      { rawText: "lent zelalem 800", ops: loan("zelalem", "lent", 80000, "l1") },
      T,
    ).result;
    expect(blocked(raw)).toBeNull();
    // Money > Lent and owed: "Paid me back" writes its own loan event.
    applyOps(c, "user", null, loan("Zelalem", "paid_me", 30000, "l2"), T + 1);
    expect(blocked(raw)).toBe("This loan has changed since. Edit it on Money > Lent and owed.");
    expect(() => captureUndo(c, { rawId: raw }, T + 2)).toThrow(/loan has changed since/);
    expect(c.all("SELECT id FROM money_loans WHERE deleted_at IS NULL ORDER BY id")).toEqual([
      { id: "l1" },
      { id: "l2" },
    ]);
  });

  it("a loan to someone else doesn't count", () => {
    const { c, blocked } = setup();
    const raw = captureCommit(
      c,
      { rawText: "lent zelalem 800", ops: loan("zelalem", "lent", 80000, "l1") },
      T,
    ).result;
    applyOps(c, "user", null, loan("abel", "lent", 30000, "l2"), T + 1);
    expect(blocked(raw)).toBeNull();
  });
});

describe("away lines undone in turn (reg2-6, F41)", () => {
  it("undoes the earlier away once the later one is undone", () => {
    const { c, blocked } = setup();
    const first = captureCommit(c, { rawText: "away tomorrow" }, T).result;
    setAway(c, { until: "2026-11-25", rawId: first }, T);
    const second = captureCommit(c, { rawText: "away till fri" }, T + 1).result;
    setAway(c, { until: "2026-11-27", rawId: second }, T + 1);
    expect(blocked(first)).toBe("Away has changed since. Set it on Today.");
    captureUndo(c, { rawId: second }, T + 2);
    expect(settingString(c, AWAY_KEY)).toBe("2026-11-25");
    expect(blocked(first)).toBeNull();
    captureUndo(c, { rawId: first }, T + 3);
    expect((settingString(c, AWAY_KEY) ?? "") > "2026-11-24").toBe(false);
  });

  it("'back' ends away under its capture, so Ctrl+Z puts away back", () => {
    const { c } = setup();
    const away = captureCommit(c, { rawText: "away for 3 days" }, T).result;
    setAway(c, { until: "2026-11-27", rawId: away }, T);
    const back = captureCommit(c, { rawText: "back" }, T + 1).result;
    clearAway(c, { rawId: back }, T + 1);
    expect(settingString(c, AWAY_KEY)).toBe("");
    const [last] = c.all(LAST_CAPTURE_SQL) as unknown as LastCapture[];
    expect(last?.id).toBe(back);
    expect(last?.parse_status).toBe("parsed");
    captureUndo(c, { rawId: back }, T + 2);
    expect(settingString(c, AWAY_KEY)).toBe("2026-11-27");
  });
});

describe("a pinned line and a cheat sheet saved since (reg2-7)", () => {
  const pin: Op = {
    op: "insert",
    table: "note_items",
    id: "pin1",
    values: { kind: "cheat", status: "kept", body: "never git rebase on main", area_id: null },
  };
  const card = (c: ReturnType<typeof setup>["c"]) => {
    const [first] = groupCards(c.all(CHEAT_SQL) as unknown as CheatRow[]);
    if (!first) throw new Error("no card");
    return first;
  };

  it("saving a card unchanged, or only adding a line, leaves the pin undoable", () => {
    const { c, blocked } = setup();
    const raw = captureCommit(
      c,
      { rawText: "pin: never git rebase on main", ops: [pin] },
      T,
    ).result;
    expect(editOps(card(c), "never git rebase on main", () => "x")).toEqual([]);
    const added = editOps(card(c), "never git rebase on main\nuse --force-with-lease", () => "n1");
    expect(added).toEqual([
      expect.objectContaining({
        op: "insert",
        id: "n1",
        values: expect.objectContaining({ sort_order: null }),
      }),
    ]);
    applyOps(c, "user", "notes:1", added, T + 1);
    expect(card(c).lines.map((line) => line.body)).toEqual([
      "never git rebase on main",
      "use --force-with-lease",
    ]);
    expect(blocked(raw)).toBeNull();
  });

  it("fixing another line leaves a later pin undoable", () => {
    const { c, blocked } = setup();
    captureCommit(
      c,
      { rawText: "pin: a", ops: [{ ...pin, id: "a", values: { ...pin.values, body: "a" } }] },
      T,
    );
    applyOps(
      c,
      "user",
      "notes:1",
      editOps(card(c), "A", () => "x"),
      T + 1,
    );
    const raw = captureCommit(
      c,
      {
        rawText: "pin: git stash pop",
        ops: [{ ...pin, id: "p", values: { ...pin.values, body: "git stash pop" } }],
      },
      T + 2,
    ).result;
    const fixed = editOps(card(c), "A!\ngit stash pop\nnew", () => "n1");
    expect(fixed).toEqual([
      { op: "update", table: "note_items", id: "a", values: { body: "A!", sort_order: 0 } },
      expect.objectContaining({ id: "n1", values: expect.objectContaining({ sort_order: null }) }),
    ]);
    applyOps(c, "user", "notes:2", fixed, T + 3);
    expect(card(c).lines.map((line) => line.body)).toEqual(["A!", "git stash pop", "new"]);
    expect(blocked(raw)).toBeNull();
  });

  it("editing the pinned line blocks it, and says where to edit", () => {
    const { c, blocked } = setup();
    const raw = captureCommit(
      c,
      { rawText: "pin: never git rebase on main", ops: [pin] },
      T,
    ).result;
    applyOps(
      c,
      "user",
      "notes:1",
      editOps(card(c), "never rebase main", () => "x"),
      T + 1,
    );
    expect(blocked(raw)).toBe("You've changed this line since. Edit it on Plan > Cheat sheets.");
  });

  it("a reordered card still keeps its order", () => {
    const { c } = setup();
    captureCommit(
      c,
      { rawText: "pin: a", ops: [{ ...pin, id: "a", values: { ...pin.values, body: "a" } }] },
      T,
    );
    captureCommit(
      c,
      { rawText: "pin: b", ops: [{ ...pin, id: "b", values: { ...pin.values, body: "b" } }] },
      T + 1,
    );
    applyOps(
      c,
      "user",
      "notes:1",
      editOps(card(c), "b\na", () => "x"),
      T + 2,
    );
    expect(card(c).lines.map((line) => line.body)).toEqual(["b", "a"]);
    applyOps(
      c,
      "user",
      "notes:2",
      editOps(card(c), "b\na\nc", () => "c"),
      T + 3,
    );
    expect(card(c).lines.map((line) => line.body)).toEqual(["b", "a", "c"]);
  });
});

describe("fixing a line from Add for today (reg2-5)", () => {
  it("is saved as an Add-for-today line and read back as a task for that day", () => {
    const { c } = setup();
    const parsed = todayTask("buy stampz", "2026-11-24", T);
    expect(parsed).toMatchObject({ kind: "task", title: "buy stampz", dueDate: "2026-11-24" });
    captureCommit(
      c,
      {
        rawText: "buy stampz",
        ops: [{ op: "insert", table: "task_items", id: "t", values: { title: "buy stampz" } }],
        parser: TODAY_PARSER_ID,
      },
      T,
    );
    const [last] = c.all(LAST_CAPTURE_SQL) as unknown as LastCapture[];
    expect(last?.parser_id).toBe(TODAY_PARSER);
    expect(last?.received_at).toBe(T);
    // The bar reads the corrected text the way Add for today did: still today.
    expect(todayTask("buy stamps", "2026-11-24", T + 60_000)).toMatchObject({
      kind: "task",
      title: "buy stamps",
      dueDate: "2026-11-24",
    });
  });
});
