import { beforeEach, describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { checkWithDate } from "../projects/capacity";
import { ask, setProvider } from "./ask";
import { acceptGuessOps, briefFacts, estimateFacts, timingFacts } from "./facts";
import { mock } from "./providers";
import { plain, runTask } from "./task";
import { BRIEF, CAPTURE, ESTIMATE, label, REVIEW, TIMING } from "./touchpoints";

const WEEK = { capacity: 1000, areaCommitted: 500 };
const TODAY = "2026-11-11";
const NOW = Date.parse("2026-11-11T09:00:00Z");

beforeEach(() => {
  plain.bad = 0;
  plain.until = 0;
  setProvider(null);
});

const check = checkWithDate(1800, "2026-12-20", TODAY, WEEK, []);
const facts = timingFacts(
  { title: "CLI budget tool", area: "coding" },
  1800,
  "2026-12-20",
  check,
  [{ title: "Portfolio site", area: "coding" }],
  false,
);

describe("timing reasons", () => {
  it("sends the app's numbers and verdict, nothing else", () => {
    expect(facts).toEqual({
      idea: "CLI budget tool",
      verdict: "Good",
      estimateH: 30,
      deadline: "2026-12-20",
      weeklyNeeded: "5 h 15",
      loadBefore: 50,
      loadAfter: 82,
      activeProjects: ["Portfolio site"],
      suggestion: { start: "2026-11-16", finish: "2026-12-27" },
    });
    expect(TIMING.facts(facts)).toContain("verdict (fixed, from the app): Good");
  });

  it("keeps a grounded reply and drops one with made-up numbers", async () => {
    const good = mock({ timing: '{"reasons":["It needs 5 h 15 a week, and load stays at 82%."]}' });
    expect(await runTask(TIMING, facts, good)).toMatchObject({ ok: true });
    const bad = mock({ timing: '{"reasons":["Load would reach 95%."]}' });
    expect(await runTask(TIMING, facts, bad)).toMatchObject({ ok: false, code: /^ungrounded/ });
  });

  it("sends area names in strict mode", () => {
    const strict = timingFacts(
      { title: "CLI budget tool", area: "coding" },
      1800,
      "2026-12-20",
      check,
      [{ title: "Portfolio site", area: "coding" }],
      true,
    );
    expect(strict.idea).toBe("a coding project");
    expect(strict.activeProjects).toEqual(["a coding project"]);
    expect(JSON.stringify(strict)).not.toMatch(/CLI|Portfolio/);
    expect(label("x", null, true, "task")).toBe("a general task");
  });
});

describe("estimates", () => {
  const input = estimateFacts(
    { title: "learn Go", area: "coding" },
    [
      { title: "Portfolio site", area: "coding", estimate_min: 1200 },
      { title: "No estimate", area: null, estimate_min: null },
    ],
    false,
  );

  it("shows other projects for scale", () => {
    expect(input).toEqual({
      idea: "learn Go",
      area: "coding",
      similar: ["Portfolio site: 20 h"],
    });
  });

  it("lets the estimate be the one new number", async () => {
    const reply =
      '{"estimate_h":15,"confidence":"medium","assumptions":["About 15 h of tutorials."]}';
    expect(await runTask(ESTIMATE, input, mock({ estimate: reply }))).toMatchObject({
      ok: true,
      value: { estimate_h: 15 },
    });
    const invented = '{"estimate_h":15,"confidence":"medium","assumptions":["3 weekends."]}';
    expect((await runTask(ESTIMATE, input, mock({ estimate: invented }))).ok).toBe(false);
    const huge = '{"estimate_h":9000,"confidence":"low","assumptions":[]}';
    expect((await runTask(ESTIMATE, input, mock({ estimate: huge }))).ok).toBe(false);
  });
});

describe("brief line", () => {
  const input = briefFacts(
    {
      blocks: [
        { kind: "fixed", area: "joba", minutes: 240 },
        { kind: "area", area: "coding", minutes: 90 },
        { kind: "area", area: "coding", minutes: 50 },
        { kind: "rest", area: null, minutes: 60 },
      ],
      top: [{ title: "Send the CV", area: null }],
      week: [
        { name: "Job hunt", done_min: 60, target_min: 240 },
        { name: "Gym", done_min: 0, target_min: 0 },
      ],
    },
    false,
  );

  it("sums minutes per area and lists the areas behind", () => {
    expect(input).toEqual({
      blocks: [
        { area: "joba", minutes: 240 },
        { area: "coding", minutes: 140 },
      ],
      top: ["Send the CV"],
      behind: [{ area: "Job hunt", percent: 25 }],
    });
  });

  it("refuses long lines", async () => {
    const long = JSON.stringify({ line: Array.from({ length: 30 }, () => "word").join(" ") });
    expect((await runTask(BRIEF, input, mock({ brief: long }))).ok).toBe(false);
    const ok = '{"line":"Send the CV first; Job hunt is at 25% this week."}';
    expect(await runTask(BRIEF, input, mock({ brief: ok }))).toMatchObject({ ok: true });
  });
});

describe("night review reply", () => {
  it("answers in words grounded in the evening", async () => {
    const input = { mind: "worried about the interview", energy: 1, doneToday: 3 };
    const reply =
      '{"reply":"You finished 3 tasks. Tomorrow, write a few questions for the interview."}';
    expect(await runTask(REVIEW, input, mock({ review: reply }))).toMatchObject({ ok: true });
  });
});

describe("strict grounding", () => {
  it("rejects a number the evening didn't have, even in words", async () => {
    const input = { mind: "worried about the interview", energy: 1, doneToday: 3 };
    const reply = '{"reply":"Write two questions for the interview."}';
    expect(await runTask(REVIEW, input, mock({ review: reply }))).toMatchObject({
      ok: false,
      code: "ungrounded:numbers not in the facts: 2",
    });
  });
});

describe("capture fallback", () => {
  const input = {
    notes: [
      { ref: "n1", body: "call the bank about the card tomorrow" },
      { ref: "n2", body: "podcast about local history" },
    ],
    areas: [
      { id: "admin", name: "Life admin" },
      { id: "experiments", name: "Experiments" },
    ],
  };

  it("checks refs and areas exist", async () => {
    const good = JSON.stringify({
      items: [
        {
          ref: "n1",
          kind: "task",
          area: "admin",
          title: "Call the bank about the card",
          when_text: "tomorrow",
          confidence: "high",
        },
        {
          ref: "n2",
          kind: "idea",
          area: "experiments",
          title: "Local history podcast",
          confidence: "medium",
        },
      ],
    });
    expect(await runTask(CAPTURE, input, mock({ capture: good }))).toMatchObject({ ok: true });
    const badRef = good.replace('"n2"', '"n9"');
    expect(await runTask(CAPTURE, input, mock({ capture: badRef }))).toMatchObject({
      code: "ungrounded:unknown refs: n9",
    });
    const badArea = good.replace('"experiments"', '"crypto"');
    expect(await runTask(CAPTURE, input, mock({ capture: badArea }))).toMatchObject({
      code: "ungrounded:unknown areas: crypto",
    });
  });

  it("turns an accepted guess into writes the schema takes", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO note_items (id, kind, status, body, created_at, updated_at)
      VALUES ('n1', 'inbox', 'inbox', 'call the bank tomorrow', 0, 0)`);
    let n = 0;
    const ops = acceptGuessOps(
      { id: "n1", body: "call the bank tomorrow" },
      {
        ref: "n1",
        kind: "task",
        area: "admin",
        title: "Call the bank",
        when_text: "tomorrow",
        confidence: "high",
      },
      ["admin"],
      NOW,
      () => `t${++n}`,
    );
    expect(ops).toEqual([
      {
        op: "insert",
        table: "task_items",
        id: "t1",
        values: {
          title: "Call the bank",
          status: "todo",
          due_date: "2026-11-12",
          area_id: "admin",
          origin: "note:n1",
        },
      },
      { op: "update", table: "note_items", id: "n1", values: { status: "converted" } },
    ]);
    const idea = acceptGuessOps(
      { id: "n1", body: "x" },
      {
        ref: "n1",
        kind: "idea",
        area: "nope",
        title: "Podcast",
        when_text: null,
        confidence: "low",
      },
      ["admin"],
      NOW,
      () => "p1",
    );
    expect(idea[0]).toMatchObject({
      table: "project_items",
      values: { title: "Podcast", area_id: null, status: "idea" },
    });
  });
});

describe("asking once", () => {
  it("asks each question once and retries after a failure", async () => {
    let calls = 0;
    const provider = mock({
      review: () => {
        calls += 1;
        return calls === 1
          ? { ok: false, code: "network:down" }
          : { ok: true, text: '{"reply":"Noted."}' };
      },
    });
    setProvider(provider);
    const input = { mind: "x", energy: null, doneToday: 0 };
    expect((await ask(REVIEW, input)).ok).toBe(false);
    expect((await ask(REVIEW, input)).ok).toBe(true);
    expect((await ask(REVIEW, input)).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("strict mode while loading", () => {
  it("is unknown until the setting has loaded", async () => {
    const { strictOrNull } = await import("./strict");
    expect(strictOrNull({ loading: true, rows: [] })).toBeNull();
    expect(strictOrNull({ loading: false, rows: [] })).toBe(false);
    expect(strictOrNull({ loading: false, rows: [{ value_json: "true" }] })).toBe(true);
  });
});
