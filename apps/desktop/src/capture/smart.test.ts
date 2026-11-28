import { describe, expect, it } from "vitest";

import { createFakeClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { openTestDb } from "../test/sqlite";
import { nodeConn } from "../dev/conn";
import { captureCommit, captureOpsAllowed, captureReplace, captureUndo } from "../dev/commands";
import { type Op } from "../dev/tx";
import { maskAmounts, unmask } from "../features/ai/mask";
import {
  COMMAND,
  type CommandFacts,
  type CommandItem,
  groundCommand,
} from "../features/ai/touchpoints";
import { mock } from "../features/ai/providers";
import { plain, runTask } from "../features/ai/task";
import { parseCapture } from "./parse";
import {
  accepted,
  clauses,
  commandFacts,
  needsAi,
  proposal,
  restore,
  rowKey,
  rowsFor,
  type RowsState,
  rowText,
  type SmartContext,
} from "./smart";

// Saturday 28 Nov 2026, 10:00 in Addis.
const clock = createFakeClock(Date.parse("2026-11-28T10:00:00+03:00"));
const nowMs = clock.now();
const areas = [
  { id: "joba", name: "Job A" },
  { id: "jobb", name: "Job B" },
];
const open = [
  { id: "t1", title: "Payroll report", kind: "task" as const },
  { id: "p1", title: "Portfolio site", kind: "project" as const },
];

function ids() {
  let n = 0;
  return () => `id${++n}`;
}

function context(): SmartContext {
  return { nowMs, newId: ids(), areas, open };
}

const read = (text: string) => parseCapture(text, { nowMs, areas });

describe("needsAi", () => {
  it.each([
    // Prefixes and lines the rules read cleanly never go out.
    ["t: call bank fri", false],
    ["n: the wifi code is on the fridge", false],
    ["idea: a podcast about local history", false],
    ["? wifi", false],
    ["lunch 120", false],
    ["lunch 120, taxi 40, coffee 30, bread 25", false],
    ["afford 4500 shoes", false],
    ["away till mon", false],
    ["back", false],
    ["call bank tomorrow 10am", false],
    // Unsure: inbox, Amharic, long, several clauses, commands the rules don't know.
    ["dentist maybe sometime", true],
    ["ነገ ባንክ መደወል", true],
    ["call ባንክ tomorrow", true],
    // The rules read this as an expense of 3 birr: Amharic goes to the AI even as money.
    ["ሰኞ ዶክተር ቀጠሮ ከጠዋቱ 3", true],
    ["ዛሬ ምሳ 150", true],
    ["back in addis from tomorrow", true],
    ["in 3 days call mom", false],
    ["send the invoice to the client and also fix the export bug before the demo on friday", true],
    ["call mom, buy bread, fix the bike", true],
    ["move the payroll report to fri", true],
    ["push the report to monday", true],
    ["reschedule dentist", true],
    ["finish the payroll report by wed", true],
    ["off tue", true],
    ["light day tomorrow", true],
    ["i'm in adama", true],
    ["working from adama this week", true],
  ])("%s → %s", (text, expected) => {
    expect(needsAi(read(text), text)).toBe(expected);
  });

  it("never in strict or plain mode", () => {
    const text = "dentist maybe sometime";
    expect(needsAi(read(text), text, { strict: true })).toBe(false);
    expect(needsAi(read(text), text, { plain: true })).toBe(false);
  });

  it("not for a line with only a day in it", () => {
    expect(needsAi(read("tomorrow"), "tomorrow")).toBe(false);
  });

  it("counts clauses on commas, semicolons, and, also", () => {
    expect(clauses("a, b; c")).toBe(3);
    expect(clauses("a and then b")).toBe(2);
    expect(clauses("fix the bike")).toBe(1);
  });
});

describe("masking amounts", () => {
  it("hides amounts and keeps times, dates and lengths", () => {
    const masked = maskAmounts("lunch 120, paid $15 and 2k rent by 20 dec at 3pm ~2h, 2026-12-01");
    expect(masked.text).toBe(
      "lunch <a1>, paid <a2> and <a3> rent by 20 dec at 3pm ~2h, 2026-12-01",
    );
    expect(unmask(masked.text, masked.amounts)).toBe(
      "lunch 120, paid $15 and 2k rent by 20 dec at 3pm ~2h, 2026-12-01",
    );
  });

  it("masks Amharic lines too", () => {
    const masked = maskAmounts("ምሳ 150 ነገ");
    expect(masked.text).toBe("ምሳ <a1> ነገ");
    expect(masked.amounts).toEqual({ "<a1>": "150" });
  });

  it("masks an amount stuck to its word, and keeps short ids", () => {
    expect(maskAmounts("ምሳ120 ዛሬ").text).toBe("ምሳ<a1> ዛሬ");
    expect(maskAmounts("taxi40 and lunch120 and coffee").text).toBe(
      "taxi<a1> and lunch<a2> and coffee",
    );
    expect(maskAmounts("ምሳ120ብር").text).toBe("ምሳ<a1>ብር");
    expect(maskAmounts("job2 and a1 and mp3s").text).toBe("job2 and a1 and mp3s");
  });

  it("a bare m is minutes only for a short length", () => {
    expect(maskAmounts("120m for laptop").text).toBe("<a1>m for laptop");
    expect(maskAmounts("run 45m").text).toBe("run 45m");
  });

  it("keeps an Amharic clock time, and masks birr", () => {
    expect(maskAmounts("ሰኞ ዶክተር ቀጠሮ ከጠዋቱ 3").text).toBe("ሰኞ ዶክተር ቀጠሮ ከጠዋቱ 3");
    expect(maskAmounts("በ3 ሰዓት ስብሰባ").text).toBe("በ3 ሰዓት ስብሰባ");
    expect(maskAmounts("ማታ 2 ምሳ 150 ብር").text).toBe("ማታ 2 ምሳ <a1> ብር");
    // A small amount is still money: `በ10 ብር`, `በ5` alone.
    expect(maskAmounts("በ10 ብር ገዛሁ").text).toBe("በ<a1> ብር ገዛሁ");
    expect(maskAmounts("ዳቦ በ5").text).toBe("ዳቦ በ<a1>");
  });

  it("the fact sheet never holds an amount", () => {
    const facts = commandFacts("lunch 120 and call abel at 3", nowMs, areas, open);
    expect(COMMAND.facts(facts)).not.toContain("120");
    expect(COMMAND.facts(facts)).toContain("lunch <a1> and call abel at 3");
    expect(COMMAND.facts(facts)).toContain("today: 2026-11-28 (Sat)");
    const titled = commandFacts("move rent to fri", nowMs, areas, [
      { id: "t2", title: "Pay rent 12000", kind: "task" },
    ]);
    expect(COMMAND.facts(titled)).toContain("- t2 (task): Pay rent <a>");
  });

  it("a reply is read back with the amounts in place", () => {
    const item: CommandItem = {
      intent: "money",
      title: "Lunch <a1>",
      span: "lunch <a1>",
      confidence: "high",
    };
    expect(restore(item, { "<a1>": "120" })).toMatchObject({
      title: "Lunch 120",
      span: "lunch 120",
    });
  });
});

describe("grounding a COMMAND reply", () => {
  const facts: CommandFacts = commandFacts("lunch 120 and move payroll to fri", nowMs, areas, open);
  const ok = (item: Partial<CommandItem>): CommandItem => ({
    intent: "task",
    title: "Call Abel",
    confidence: "high",
    ...item,
  });

  it("takes known ids, readable dates and spans from the line", () => {
    expect(
      groundCommand(
        [
          ok({ intent: "money", span: "lunch <a1>" }),
          ok({ intent: "move", target: "t1", when_text: "fri" }),
          ok({ area: "joba", when_text: "tomorrow 3pm" }),
        ],
        facts,
      ),
    ).toBeNull();
  });

  it.each([
    [ok({ area: "nope" }), /unknown area/],
    [ok({ intent: "move", target: "t9", when_text: "fri" }), /unknown target/],
    [ok({ intent: "money", span: "dinner <a1>" }), /span is not in the line/],
    [ok({ when_text: "sometime soonish" }), /can't read/],
    [ok({ intent: "finish_by", by_text: "whenever" }), /can't read/],
    [ok({ intent: "move", target: "t1" }), /no when_text/],
    [ok({ intent: "place" }), /no place/],
    [ok({ title: "Pay 900" }), /numbers not in the facts/],
    [ok({ area_phrase: "for job c" }), /area words/],
  ])("refuses %o", (item, why) => {
    expect(groundCommand([item], facts)).toMatch(why);
  });

  it("a bad reply is thrown away by runTask", async () => {
    plain.bad = 0;
    plain.until = 0;
    const provider = mock({
      command: JSON.stringify({
        items: [{ intent: "task", title: "X", area: "zzz", confidence: "low" }],
      }),
    });
    const result = await runTask(COMMAND, facts, provider, () => clock.now());
    expect(result).toEqual({ ok: false, code: "ungrounded:item 1: unknown area zzz" });
    plain.bad = 0;
    // What was sent has no amount in it.
    expect(provider.requests[0]?.prompt).not.toContain("120");
  });

  it("allows at most 6 items", async () => {
    const items = Array.from({ length: 7 }, () => ({
      intent: "note",
      title: "x",
      confidence: "low",
    }));
    const result = await runTask(COMMAND, facts, mock({ command: JSON.stringify({ items }) }), () =>
      clock.now(),
    );
    expect(result.ok).toBe(false);
    plain.bad = 0;
  });
});

describe("intents become ops (the model decides nothing)", () => {
  it("task: estimate from size, day from when_text, steps under it", () => {
    const made = proposal(
      {
        intent: "task",
        title: "Fix the export bug",
        area: "jobb",
        when_text: "today",
        size: "m",
        steps: ["Find the bad row", "Write a test"],
        confidence: "high",
      },
      context(),
    );
    expect(made?.label).toBe("Fix the export bug · Today · Job B · ~1 h · 2 steps");
    expect(made?.ops[0]).toMatchObject({
      op: "insert",
      table: "task_items",
      id: "id1",
      values: {
        title: "Fix the export bug",
        estimate_min: 60,
        due_date: "2026-11-28",
        area_id: "jobb",
      },
    });
    expect(made?.ops.slice(1)).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({ parent_id: "id1", step_no: 1 }),
      }),
      expect.objectContaining({
        values: expect.objectContaining({ parent_id: "id1", step_no: 2 }),
      }),
    ]);
  });

  it("task: Ethiopian clock times read as such", () => {
    const made = proposal(
      {
        intent: "task",
        title: "Call Abel",
        when_text: "tomorrow at 3",
        ethiopian_clock: true,
        confidence: "high",
      },
      context(),
    );
    const values = (made?.ops[0] as { values: Record<string, unknown> }).values;
    expect(values.due_date).toBe("2026-11-29");
    expect(values.due_at).toBe(Date.parse("2026-11-29T09:00:00+03:00"));
  });

  it("money: the span is read by the rules, here", () => {
    const made = proposal(
      { intent: "money", title: "Lunch", span: "lunch 120", confidence: "high" },
      context(),
    );
    expect(made?.ops[0]).toMatchObject({
      table: "money_txns",
      values: { amount_minor: -12_000 },
    });
  });

  it("money: a span the rules can't read as money is left out", () => {
    expect(
      proposal({ intent: "money", title: "x", span: "call abel", confidence: "low" }, context()),
    ).toBeNull();
  });

  it("move: a task's due and planned day", () => {
    const made = proposal(
      { intent: "move", title: "Move payroll", target: "t1", when_text: "fri", confidence: "high" },
      context(),
    );
    expect(made?.ops).toEqual([
      {
        op: "update",
        table: "task_items",
        id: "t1",
        values: { due_date: "2026-12-04", planned_date: "2026-12-04" },
      },
    ]);
    expect(made?.label).toBe("Move: Payroll report · Fri 4 Dec");
  });

  it("move: a timed task keeps its time of day, and its reminder moves with it", () => {
    // `call bank fri 10am`: due and reminded Fri 4 Dec 10:00 (reminders.rs reads remind_at).
    const due = Date.parse("2026-12-04T10:00:00+03:00");
    const timed = {
      nowMs,
      newId: ids(),
      areas,
      open: [
        {
          id: "t3",
          title: "Call bank",
          kind: "task" as const,
          dueAt: due,
          remindAt: due - 30 * 60 * 1000,
        },
      ],
    };
    const moved = proposal(
      { intent: "move", title: "Move", target: "t3", when_text: "mon", confidence: "high" },
      timed,
    );
    expect(moved?.ops[0]).toMatchObject({
      values: {
        due_date: "2026-11-30",
        planned_date: "2026-11-30",
        due_at: Date.parse("2026-11-30T10:00:00+03:00"),
        remind_at: Date.parse("2026-11-30T09:30:00+03:00"),
      },
    });
    // A time in the words sets both.
    const at = proposal(
      { intent: "move", title: "Move", target: "t3", when_text: "mon 3pm", confidence: "high" },
      timed,
    );
    expect(at?.ops[0]).toMatchObject({
      values: {
        due_at: Date.parse("2026-11-30T15:00:00+03:00"),
        remind_at: Date.parse("2026-11-30T15:00:00+03:00"),
      },
    });
    // `finish by wed` moves the deadline's instant too.
    const by = proposal(
      { intent: "finish_by", title: "x", target: "t3", by_text: "wed", confidence: "high" },
      timed,
    );
    expect(by?.ops[0]).toMatchObject({
      values: { due_date: "2026-12-02", due_at: Date.parse("2026-12-02T10:00:00+03:00") },
    });
    // Both instants pass the capture gate, and they are never sent to the model.
    expect(captureOpsAllowed(moved?.ops ?? [])).toBe(true);
    expect(
      JSON.stringify(commandFacts("move call bank to mon", nowMs, areas, timed.open)),
    ).not.toContain(String(due));
  });

  it("move: a project can't be moved here", () => {
    expect(
      proposal(
        { intent: "move", title: "x", target: "p1", when_text: "fri", confidence: "high" },
        context(),
      ),
    ).toBeNull();
  });

  it("finish_by: an open task gets the deadline; a new one is a task due that day", () => {
    expect(
      proposal(
        { intent: "finish_by", title: "Payroll", target: "t1", by_text: "wed", confidence: "high" },
        context(),
      )?.ops,
    ).toEqual([
      { op: "update", table: "task_items", id: "t1", values: { due_date: "2026-12-02" } },
    ]);
    const made = proposal(
      { intent: "finish_by", title: "Send the deck", by_text: "wed", confidence: "high" },
      context(),
    );
    expect(made?.ops[0]).toMatchObject({ table: "task_items", values: { due_date: "2026-12-02" } });
    expect(made?.label).toBe("Finish by Wed 2 Dec: Send the deck · Wed 2 Dec");
  });

  it("day_mode: off today sets away till tomorrow; another day is kept as a note", () => {
    expect(
      proposal(
        { intent: "day_mode", title: "Day off", mode: "off", confidence: "high" },
        context(),
      ),
    ).toEqual({
      label: "Day off · Today",
      ops: [],
      effect: { kind: "away", until: "2026-11-29" },
    });
    const later = proposal(
      {
        intent: "day_mode",
        title: "Off on Tuesday",
        mode: "off",
        when_text: "tue",
        confidence: "high",
      },
      context(),
    );
    expect(later?.ops[0]).toMatchObject({
      table: "note_items",
      values: { body: "Off on Tuesday" },
    });
  });

  it("place: the prayer-times city", () => {
    expect(
      proposal(
        { intent: "place", title: "In Adama", place: "adama", confidence: "high" },
        context(),
      ),
    ).toEqual({
      label: "In Adama · prayer times from here",
      ops: [
        {
          op: "upsert",
          table: "core_settings",
          id: "prayer.city",
          values: { value_json: '"adama"' },
        },
      ],
    });
  });

  it("question: the existing search", () => {
    expect(
      proposal(
        { intent: "question", title: "Wifi", span: "wifi code", confidence: "high" },
        context(),
      ),
    ).toEqual({
      label: "Search: wifi code",
      ops: [],
      effect: { kind: "search", query: "wifi code" },
    });
  });

  it("every op a row makes is one the capture commands allow", () => {
    const items: CommandItem[] = [
      { intent: "task", title: "Call Abel", when_text: "mon", size: "s", confidence: "high" },
      { intent: "note", title: "Wifi is on the fridge", confidence: "high" },
      { intent: "money", title: "Lunch", span: "lunch 120", confidence: "high" },
      { intent: "move", title: "Move", target: "t1", when_text: "fri", confidence: "high" },
      { intent: "finish_by", title: "x", target: "t1", by_text: "wed", confidence: "high" },
      { intent: "place", title: "x", place: "addis", confidence: "high" },
    ];
    const { ops } = accepted(rowsFor(items, context()), context());
    expect(captureOpsAllowed(ops as Op[])).toBe(true);
  });
});

describe("the rows in the capture box", () => {
  const items: CommandItem[] = [
    {
      intent: "task",
      title: "Send invoice",
      when_text: "tue",
      area: "jobb",
      size: "m",
      confidence: "high",
    },
    { intent: "move", title: "Move", target: "t1", when_text: "fri", confidence: "high" },
    { intent: "move", title: "Move a project", target: "p1", when_text: "fri", confidence: "high" },
  ];
  const start: RowsState = { rows: rowsFor(items, context()), cursor: 0 };
  const key = (state: RowsState, name: string, shift = false) =>
    rowKey(
      state,
      name,
      shift,
      areas.map((a) => a.id),
    );
  const next = (state: RowsState, name: string, shift = false) => {
    const action = key(state, name, shift);
    if (action.kind !== "state") throw new Error(`no state for ${name}`);
    return action.state;
  };

  it("shows only rows the app can do, each ticked", () => {
    expect(start.rows.map((row) => rowText(row, context()))).toEqual([
      "✓ Send invoice · Tue 1 Dec · Job B · ~1 h",
      "✓ Move: Payroll report · Fri 4 Dec",
    ]);
  });

  it("Enter accepts, Escape keeps the note", () => {
    expect(key(start, "Enter")).toEqual({ kind: "accept" });
    expect(key(start, "Escape")).toEqual({ kind: "keep" });
    expect(key(start, "x")).toEqual({ kind: "ignore" });
  });

  it("Up/Down move and wrap; Space turns a row off and on", () => {
    const down = next(start, "ArrowDown");
    expect(down.cursor).toBe(1);
    expect(next(down, "ArrowDown").cursor).toBe(0);
    expect(next(start, "ArrowUp").cursor).toBe(1);
    const off = next(down, " ");
    expect(off.rows.map((row) => row.on)).toEqual([true, false]);
    expect(off.rows.map((row) => rowText(row, context()))[1]).toBe(
      "✗ Move: Payroll report · Fri 4 Dec",
    );
    expect(accepted(off.rows, context()).count).toBe(1);
    expect(next(off, " ").rows[1]?.on).toBe(true);
  });

  it("Tab cycles a row's area, through none; Shift+Tab goes back", () => {
    const b = start.rows[0]?.item.area;
    expect(b).toBe("jobb");
    const none = next(start, "Tab");
    expect(none.rows[0]?.item.area).toBeUndefined();
    expect(none.rows.map((row) => rowText(row, context()))[0]).toBe(
      "✓ Send invoice · Tue 1 Dec · ~1 h",
    );
    expect(next(none, "Tab").rows[0]?.item.area).toBe("joba");
    expect(next(start, "Tab", true).rows[0]?.item.area).toBe("joba");
    // A move has no area to change.
    expect(key({ ...start, cursor: 1 }, "Tab")).toEqual({ kind: "ignore" });
  });
});

describe("accepting replaces the note, so undo still works", () => {
  it("note → task + move + city, and Ctrl+Z puts all of it back", () => {
    const c = nodeConn(openTestDb());
    c.run(
      "INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES ('t1', 'Payroll report', 'todo', 1, 1)",
    );
    const text = "call abel mon, move payroll to fri, i'm in adama";
    const { result: rawId } = captureCommit(
      c,
      {
        rawText: text,
        ops: [
          {
            op: "insert",
            table: "note_items",
            id: "n1",
            values: { kind: "inbox", status: "inbox", body: text, origin: "capture" },
          },
        ],
        parser: "capture@1",
      },
      nowMs,
    );
    const items: CommandItem[] = [
      { intent: "task", title: "Call Abel", when_text: "mon", confidence: "high" },
      { intent: "move", title: "Move", target: "t1", when_text: "fri", confidence: "high" },
      { intent: "place", title: "Adama", place: "adama", confidence: "high" },
    ];
    const { ops } = accepted(rowsFor(items, context()), context());
    const { result: newId } = captureReplace(
      c,
      { rawId, rawText: text, ops, parser: "command@1" },
      nowMs + 1000,
    );
    const due = () => c.all("SELECT due_date FROM task_items WHERE id = 't1'")[0]?.due_date;
    const city = () =>
      c.all("SELECT value_json FROM core_settings WHERE key = 'prayer.city'")[0]?.value_json;
    expect(due()).toBe("2026-12-04");
    expect(city()).toBe('"adama"');
    expect(c.all("SELECT 1 FROM note_items WHERE id = 'n1' AND deleted_at IS NULL")).toHaveLength(
      0,
    );
    expect(
      c.all("SELECT 1 FROM task_items WHERE title = 'Call Abel' AND deleted_at IS NULL"),
    ).toHaveLength(1);

    captureUndo(c, { rawId: newId }, nowMs + 2000);
    expect(due()).toBeNull();
    expect(city()).toBeUndefined();
    expect(
      c.all("SELECT 1 FROM task_items WHERE title = 'Call Abel' AND deleted_at IS NULL"),
    ).toHaveLength(0);
    expect(logicalDate(nowMs)).toBe("2026-11-28");
  });
});
