import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { nodeConn } from "../dev/conn";
import {
  AWAY_KEY,
  captureCommit,
  captureReplace,
  captureUndo,
  setAway,
  settingString,
} from "../dev/commands";
import { applyOps, type Op } from "../dev/tx";
import {
  actionable,
  type BlockRow,
  CAPTURE_MADE_SQL,
  fixReading,
  LAST_CAPTURE_SQL,
  type LastCapture,
  madeKind,
  type MadeRow,
  UNDO_BLOCKED_SQL,
  undoBlocked,
} from "./fix";
import { readings } from "./alternatives";
import { parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-24T09:00:00+03:00");

function log(
  db: ReturnType<typeof openTestDb>,
  context: string | null,
  table: string,
  id: string,
  action: string,
  after: object = {},
) {
  db.prepare(
    "INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action, after_json) VALUES (1, 'user', ?, ?, ?, ?, ?)",
  ).run(context, table, id, action, JSON.stringify(after));
}

describe("fixing a capture with Up arrow (r2-7)", () => {
  it("starts on the reading of the kind the capture made", () => {
    const text = "weekly money summary";
    const options = readings(parseCapture(text, { nowMs }), text, nowMs);
    const idea = fixReading(options, "idea");
    expect(idea).toBeGreaterThan(0);
    expect(options[idea]?.kind).toBe("idea");
    expect(fixReading(options, undefined)).toBe(0);
  });

  it("reads the kind from what the capture inserted", () => {
    const db = openTestDb();
    log(db, "capture:1", "project_items", "p1", "insert");
    log(db, "capture:2", "note_items", "n1", "insert", { kind: "cheat" });
    log(db, "capture:3", "task_items", "t1", "insert");
    const made = (context: string) =>
      db.prepare(CAPTURE_MADE_SQL).all(context) as unknown as MadeRow[];
    expect(madeKind(made("capture:1"))).toBe("idea");
    expect(madeKind(made("capture:2"))).toBe("cheat");
    expect(madeKind(made("capture:3"))).toBe("task");
    expect(madeKind(made("capture:9"))).toBeUndefined();
  });

  it("won't replace a project you changed since", () => {
    const c = nodeConn(openTestDb());
    const idea: Op = { op: "insert", table: "project_items", id: "p1", values: { title: "x" } };
    applyOps(c, "user", "capture:1", [idea], 1);
    const blocked = () =>
      undoBlocked(c.all(UNDO_BLOCKED_SQL, ["capture:1"]) as unknown as BlockRow[], "fix");
    expect(blocked()).toBeNull();
    applyOps(c, "user", null, [{ ...idea, op: "update", values: { title: "y" } }], 2);
    expect(blocked()).toMatch(/Edit it on Projects/);
  });
});

describe("undoing or fixing a capture you changed since (F2, F65)", () => {
  const T = Date.parse("2026-11-24T09:30:00+03:00");
  const task = (id: string, title: string): Op[] => [
    { op: "insert", table: "task_items", id, values: { title, status: "todo" } },
  ];
  const spend = (
    id: string,
    amount: number,
    account = "cash",
    origin: string | null = null,
  ): Op => ({
    op: "insert",
    table: "money_txns",
    id,
    values: {
      account,
      occurred_at: T,
      local_date: "2026-11-24",
      amount_minor: amount,
      description: id,
      origin,
    },
  });
  const setup = () => {
    const c = nodeConn(openTestDb());
    const blocked = (raw: number, verb: "undo" | "fix" = "undo") =>
      undoBlocked(c.all(UNDO_BLOCKED_SQL, [`capture:${raw}`]) as unknown as BlockRow[], verb);
    const edit = (ops: Op[]) => applyOps(c, "user", null, ops, T + 1);
    return { c, blocked, edit };
  };

  it("leaves an untouched capture free to undo", () => {
    const { c, blocked } = setup();
    const { result: raw } = captureCommit(c, { rawText: "buy stamps", ops: task("t1", "x") }, T);
    expect(blocked(raw)).toBeNull();
  });

  it("refuses a task you ticked or edited since", () => {
    const { c, blocked, edit } = setup();
    const { result: raw } = captureCommit(c, { rawText: "buy stamps", ops: task("t1", "x") }, T);
    edit([{ op: "update", table: "task_items", id: "t1", values: { status: "done" } }]);
    expect(blocked(raw)).toBe("You've changed this task since. Edit it on Plan > Tasks.");
    expect(() => captureUndo(c, { rawId: raw }, T + 2)).toThrow(/changed this task since/);
    expect(() =>
      captureReplace(c, { rawId: raw, rawText: "buy stamps 5pm", ops: task("t2", "y") }, T + 2),
    ).toThrow(/changed this task since/);
    // Nothing moved: the ticked task stays, no new one was added.
    expect(c.all("SELECT id, status FROM task_items WHERE deleted_at IS NULL")).toEqual([
      { id: "t1", status: "done" },
    ]);
  });

  it("refuses an entry you edited on Money, and says when it is deleted", () => {
    const { c, blocked, edit } = setup();
    const lunch = captureCommit(c, { rawText: "lunch 120", ops: [spend("m1", -12000)] }, T).result;
    edit([{ op: "update", table: "money_txns", id: "m1", values: { amount_minor: -15000 } }]);
    expect(blocked(lunch)).toBe("You've changed this entry since. Edit it on Money.");
    const taxi = captureCommit(c, { rawText: "taxi 60", ops: [spend("m2", -6000)] }, T).result;
    edit([{ op: "delete", table: "money_txns", id: "m2" }]);
    expect(blocked(taxi)).toBe("Nothing to undo: you've deleted it since.");
    expect(blocked(taxi, "fix")).toBe("Nothing to fix: you've deleted it since.");
  });

  it("refuses an entry whose account was checked since", () => {
    const { c, blocked, edit } = setup();
    const raw = captureCommit(
      c,
      {
        rawText: "moved 120 cash to telebirr",
        ops: [spend("o", -12000), spend("i", 12000, "telebirr")],
      },
      T,
    ).result;
    edit([spend("r", 635000, "cash", "reconcile")]);
    expect(blocked(raw)).toBe(
      "You checked Cash since. Undo it on Money > Ledger, then check Cash again.",
    );
    // An entry in an account nobody checked is still free.
    const other = captureCommit(
      c,
      { rawText: "coffee 45", ops: [spend("c", -4500, "cbe")] },
      T + 2,
    );
    expect(blocked(other.result)).toBeNull();
  });
});

describe("the last capture (F38)", () => {
  it("a newer line that made nothing stops Ctrl+Z and Up reaching past it", () => {
    const c = nodeConn(openTestDb());
    captureCommit(
      c,
      {
        rawText: "lunch 120",
        ops: [{ op: "insert", table: "task_items", id: "t", values: { title: "x" } }],
      },
      1,
    );
    captureCommit(c, { rawText: "afford 4500 shoes" }, 2);
    const [last] = c.all(LAST_CAPTURE_SQL) as unknown as LastCapture[];
    expect(last?.body).toBe("afford 4500 shoes");
    expect(actionable(last)).toBeUndefined();
  });

  it("an away line can be undone, and undoing it ends away", () => {
    const c = nodeConn(openTestDb());
    const now = Date.parse("2026-11-24T09:30:00+03:00");
    const raw = captureCommit(c, { rawText: "away till mon" }, now).result;
    setAway(c, { until: "2026-11-30", rawId: raw }, now);
    const [last] = c.all(LAST_CAPTURE_SQL) as unknown as LastCapture[];
    expect(actionable(last)?.id).toBe(raw);
    expect(captureUndo(c, { rawId: raw }, now + 1).result).toBe(1);
    expect((settingString(c, AWAY_KEY) ?? "") > "2026-11-24").toBe(false);
  });
});
