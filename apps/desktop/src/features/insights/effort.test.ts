import { describe, expect, it } from "vitest";

import { createFakeClock } from "../../kernel/clock";
import { logicalDate } from "../../kernel/dates";
import { openTestDb } from "../../test/sqlite";
import {
  areaGaps,
  type AreaWeekRow,
  compareRates,
  compareMoneyText,
  compareText,
  driftMoneyText,
  driftText,
  gapInsights,
  type GapBlock,
  GAP_BLOCKS_SQL,
  GAP_SESSIONS_SQL,
  JOB_DAYS_SQL,
  JOB_MONTH_MINUTES_SQL,
  JOB_MONTH_PAY_SQL,
  type JobBlockRow,
  jobSkips,
  lastFullMonth,
  type MonthMinutes,
  type MonthPay,
  rateDrifts,
  ratesByMonth,
  shiftMonth,
  skipInsights,
} from "./effort";

/** An instant at an Addis local time. */
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+03:00`);
const H = 60;

describe("months", () => {
  it("moves by months and finds the last full one from a fake clock", () => {
    const clock = createFakeClock(at("2026-11-25", "10:00"));
    const today = logicalDate(clock.now());
    expect(lastFullMonth(today)).toBe("2026-10");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 2)).toBe("2027-01");
    // 02:00 on 1 Dec is still the logical 30 Nov.
    clock.set(at("2026-12-01", "02:00"));
    expect(lastFullMonth(logicalDate(clock.now()))).toBe("2026-10");
  });
});

const minutes = (area_id: string, name: string, month: string, m: number): MonthMinutes => ({
  area_id,
  name,
  month,
  minutes: m,
});
const pay = (area_id: string, month: string, minor: number, currency = "ETB"): MonthPay => ({
  area_id,
  month,
  minor,
  currency,
});

describe("1. pay per worked hour, compared", () => {
  const month = (aPay: number, bPay: number, aMin = 100 * H, bMin = 100 * H) =>
    ratesByMonth(
      [minutes("joba", "Job A", "2026-10", aMin), minutes("jobb", "Job B", "2026-10", bMin)],
      [pay("joba", "2026-10", aPay), pay("jobb", "2026-10", bPay)],
    ).get("2026-10") ?? [];

  it("says the ratio, rounded down, once both jobs have pay and 20 h", () => {
    const compare = compareRates(month(1_660_000, 1_000_000));
    expect(compare && compareText(compare)).toBe("Job A pays 1.6× Job B per hour worked.");
    // On Money, with birr: 16,600 ÷ 100 h = 166; 10,000 ÷ 100 h = 100.
    expect(compare && compareMoneyText(compare)).toBe(
      "Job A pays 1.6× Job B per hour worked (about 166 ETB against 100 ETB).",
    );
  });

  it("needs a 1.2× difference: 1.19 is nothing, 1.2 is a card", () => {
    expect(compareRates(month(1_190_000, 1_000_000))).toBeNull();
    expect(compareRates(month(1_200_000, 1_000_000))?.ratio).toBe(1.2);
  });

  it("needs 20 h for each job: 19 h 59 min is too few", () => {
    expect(compareRates(month(1_000_000, 500_000, 20 * H - 1))).toBeNull();
    // 10,000 ÷ 20 h against 5,000 ÷ 100 h.
    expect(compareRates(month(1_000_000, 500_000, 20 * H))?.ratio).toBe(10);
  });

  it("gives no card for zero pay, never a divide by zero", () => {
    expect(compareRates(month(1_000_000, 0))).toBeNull();
    expect(compareRates(month(0, 0))).toBeNull();
    expect(compareRates(month(1_000_000, 500_000, 0))).toBeNull();
  });

  it("converts foreign pay at its rate, and leaves it out without one", () => {
    const rows = [
      minutes("joba", "Job A", "2026-10", 100 * H),
      minutes("jobb", "Job B", "2026-10", 100 * H),
    ];
    const paid = [pay("joba", "2026-10", 1_000_000), pay("jobb", "2026-10", 10_000, "USD")]; // $100
    const rates = { USD: { rate: "150", set_on: "2026-10-01" } };
    // $100 × 150 = 15,000 ETB against 10,000 ETB for the same hours.
    const converted = compareRates(ratesByMonth(rows, paid, rates).get("2026-10") ?? []);
    expect(converted && compareText(converted)).toBe("Job B pays 1.5× Job A per hour worked.");
    expect(compareRates(ratesByMonth(rows, paid).get("2026-10") ?? [])).toBeNull();
  });

  it("compares the best with the lowest of three jobs", () => {
    const three = ratesByMonth(
      [
        minutes("joba", "Job A", "2026-10", 100 * H),
        minutes("jobb", "Job B", "2026-10", 100 * H),
        minutes("jobc", "Job C", "2026-10", 100 * H),
      ],
      [
        pay("joba", "2026-10", 900_000),
        pay("jobb", "2026-10", 1_800_000),
        pay("jobc", "2026-10", 1_200_000),
      ],
    ).get("2026-10");
    expect(compareRates(three ?? [])).toMatchObject({
      best: { name: "Job B" },
      other: { name: "Job A" },
      ratio: 2,
    });
  });
});

describe("2. rate trend against your 3-month usual", () => {
  /** Job B with 100 h a month and the given pay (birr) for Jul…Oct. */
  const history = (pays: (number | null)[]) => {
    const months = ["2026-07", "2026-08", "2026-09", "2026-10"];
    return ratesByMonth(
      months.map((m) => minutes("jobb", "Job B", m, 100 * H)),
      months.flatMap((m, i) => (pays[i] ? [pay("jobb", m, (pays[i] ?? 0) * 100)] : [])),
    );
  };

  it("says a fall of 10% or more against the 3 months before", () => {
    const [drift] = rateDrifts(history([10_000, 10_000, 10_000, 8_200]), "2026-10");
    expect(drift).toMatchObject({ percent: -18, last: 8_200, usual: 10_000 });
    expect(drift && driftText(drift)).toBe(
      "Job B's pay per hour fell 18% against your 3-month usual.",
    );
    expect(drift && driftMoneyText(drift)).toBe(
      "Job B's pay per hour fell 18% against your 3-month usual (about 82 ETB an hour, usually 100 ETB).",
    );
  });

  it("says a rise too", () => {
    const [drift] = rateDrifts(history([10_000, 10_000, 10_000, 12_500]), "2026-10");
    expect(drift && driftText(drift)).toBe(
      "Job B's pay per hour rose 25% against your 3-month usual.",
    );
  });

  it("is quiet under 10%: 9% is nothing, 10% is a card", () => {
    expect(rateDrifts(history([10_000, 10_000, 10_000, 9_100]), "2026-10")).toEqual([]);
    expect(rateDrifts(history([10_000, 10_000, 10_000, 9_000]), "2026-10")[0]?.percent).toBe(-10);
  });

  it("needs pay in each of the 3 months before", () => {
    expect(rateDrifts(history([null, 10_000, 10_000, 5_000]), "2026-10")).toEqual([]);
    expect(rateDrifts(history([10_000, 10_000, 10_000, 0]), "2026-10")).toEqual([]);
  });
});

describe("3. planned against worked job days", () => {
  const row = (date: string, status = "planned", m = 4 * H, area = "joba"): JobBlockRow => ({
    area_id: area,
    name: area === "joba" ? "Job A" : "Job B",
    date,
    status,
    minutes: m,
  });
  const days = (n: number) =>
    Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

  it("counts a day skipped only when every part is, and adds split-shift hours", () => {
    const rows = [
      ...days(10).flatMap((d) => [row(d, "planned", 2 * H), row(d, "planned", 2 * H)]),
      row("2026-10-11", "skipped", 2 * H),
      row("2026-10-11", "skipped", 2 * H),
      row("2026-10-12", "skipped", 2 * H), // only the morning part skipped
      row("2026-10-12", "done", 2 * H),
    ];
    expect(jobSkips(rows)).toEqual([
      {
        areaId: "joba",
        name: "Job A",
        days: 12,
        skippedDays: 1,
        plannedMin: 48 * H,
        workedMin: 42 * H,
      },
    ]);
    expect(skipInsights(jobSkips(rows), "October")).toEqual([
      {
        key: "jobSkips",
        id: "jobSkips-joba",
        text: "Job A: 1 of 12 days skipped in October (42 h of 48 h worked).",
      },
    ]);
  });

  it("needs 10 planned days: 9 is nothing, 10 is a card", () => {
    const nine = [...days(8).map((d) => row(d)), row("2026-10-20", "skipped")];
    const ten = [...nine, row("2026-10-21")];
    expect(skipInsights(jobSkips(nine), "October")).toEqual([]);
    expect(skipInsights(jobSkips(ten), "October")[0]?.text).toBe(
      "Job A: 1 of 10 days skipped in October (36 h of 40 h worked).",
    );
  });

  it("says nothing when no day was skipped", () => {
    expect(skipInsights(jobSkips(days(20).map((d) => row(d))), "October")).toEqual([]);
  });
});

describe("the job SQL", () => {
  const db = openTestDb();
  const block = db.prepare(
    "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
  );
  const add = (
    id: string,
    date: string,
    from: string,
    to: string,
    area: string | null,
    status = "planned",
    kind = "fixed",
  ) => block.run(id, date, at(date, from), at(date, to), kind, area, id, status);
  // A split shift (08-10 and 13-15), a skipped day, a moved part and a gym block.
  add("a1", "2026-10-05", "08:00", "10:00", "joba");
  add("a2", "2026-10-05", "13:00", "15:00", "joba");
  add("a3", "2026-10-06", "08:00", "10:00", "joba", "skipped");
  add("a4", "2026-10-07", "08:00", "10:00", "joba", "moved");
  add("a5", "2026-10-07", "09:00", "11:00", "joba");
  add("g1", "2026-10-05", "17:00", "18:00", "gym", "planned", "routine");
  add("b1", "2026-09-30", "08:00", "12:00", "jobb");
  db.prepare(
    "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, area_id, created_at, updated_at) VALUES ('p1', 0, '2026-10-21', 1200000, 'salary', 'joba', 0, 0), ('p2', 0, '2026-09-21', 900000, 'salary', 'jobb', 0, 0)",
  ).run();

  it("adds split-shift hours per month, skipped and moved blocks left out", () => {
    expect(db.prepare(JOB_MONTH_MINUTES_SQL).all("2026-09-01", "2026-10-31")).toEqual([
      { area_id: "joba", name: "Job A", month: "2026-10", minutes: 6 * H },
      { area_id: "jobb", name: "Job B", month: "2026-09", minutes: 4 * H },
    ]);
    expect(db.prepare(JOB_MONTH_PAY_SQL).all("2026-09-01", "2026-10-31")).toEqual([
      { area_id: "joba", month: "2026-10", minor: 1_200_000, currency: "ETB" },
      { area_id: "jobb", month: "2026-09", minor: 900_000, currency: "ETB" },
    ]);
  });

  it("lists job blocks with skipped ones, never moved ones", () => {
    const rows = db
      .prepare(JOB_DAYS_SQL)
      .all("2026-10-01", "2026-10-31") as unknown as JobBlockRow[];
    expect(rows.map((r) => `${r.date} ${r.status} ${r.minutes}`)).toEqual([
      "2026-10-05 planned 120",
      "2026-10-05 planned 120",
      "2026-10-06 skipped 120",
      "2026-10-07 planned 120",
    ]);
    expect(jobSkips(rows)[0]).toMatchObject({
      days: 3,
      skippedDays: 1,
      plannedMin: 480,
      workedMin: 360,
    });
  });

  it("gives the gap blocks with job names, and focus sessions", () => {
    const rows = db.prepare(GAP_BLOCKS_SQL).all("2026-10-05", "2026-10-05");
    expect(rows.map((r) => (r as { job: string | null }).job)).toEqual(["Job A", "Job A", null]);
    db.prepare(
      "INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at) VALUES ('f1', 'focus', ?, 25, ?)",
    ).run(at("2026-10-05", "11:00"), at("2026-10-05", "11:25"));
    expect(
      db.prepare(GAP_SESSIONS_SQL).all(at("2026-10-05", "03:00"), at("2026-10-06", "03:00")),
    ).toEqual([{ started_at: at("2026-10-05", "11:00"), ended_at: at("2026-10-05", "11:25") }]);
  });
});

describe("4. focus against target, weeks running", () => {
  const week = (done: number, target = 6 * H, change: Partial<AreaWeekRow> = {}): AreaWeekRow[] => [
    { id: "hunt", name: "Job hunt", target_min: target, done_min: done, ...change },
  ];

  it("says an area under its target 3 weeks running", () => {
    expect(areaGaps([week(5 * H), week(2 * H), week(H), week(3 * H)])).toEqual([
      {
        key: "areaGap",
        id: "areaGap-hunt",
        text: "Job hunt got 3 h of its 6 h target last week, 3 weeks running.",
      },
    ]);
  });

  it("needs 3 weeks: 2 is nothing", () => {
    expect(areaGaps([week(6 * H), week(6 * H), week(H), week(H)])).toEqual([]);
    expect(areaGaps([week(H), week(H)])).toEqual([]);
  });

  it("counts under 80% of the target: at 80% is not under", () => {
    // 6 h × 0.8 = 4 h 48 min.
    expect(areaGaps([week(288), week(H), week(H)])).toEqual([]);
    expect(areaGaps([week(287), week(H), week(H)])[0]?.text).toContain("3 weeks running");
  });

  it("leaves out capped areas and ones without a target", () => {
    expect(
      areaGaps([
        week(0, 6 * H, { capped: 1 }),
        week(0, 6 * H, { capped: 1 }),
        week(0, 6 * H, { capped: 1 }),
      ]),
    ).toEqual([]);
    expect(areaGaps([week(0, 0), week(0, 0), week(0, 0)])).toEqual([]);
  });
});

describe("idea 1. use the gap", () => {
  // Mondays 9 and 16 Nov 2026.
  const job = (
    date: string,
    from: string,
    to: string,
    name = "Job A",
    area = "joba",
  ): GapBlock => ({
    date,
    start_at: at(date, from),
    end_at: at(date, to),
    area_id: area,
    job: name,
  });
  const other = (date: string, from: string, to: string): GapBlock => ({
    date,
    start_at: at(date, from),
    end_at: at(date, to),
    area_id: null,
    job: null,
  });
  const split = (date: string, back = "13:00") => [
    job(date, "08:00", "12:00"),
    job(date, back, "17:00"),
  ];

  it("finds a 60-minute gap unused for 2 weeks", () => {
    expect(gapInsights([...split("2026-11-09"), ...split("2026-11-16")], [])).toEqual([
      {
        key: "useGap",
        id: "useGap",
        text: "Two short sessions fit 12:15–13:00 on Mon, between the parts of Job A. It went unused the last 2 weeks.",
      },
    ]);
  });

  it("needs 60 minutes: 59 is nothing", () => {
    expect(
      gapInsights([...split("2026-11-09", "12:59"), ...split("2026-11-16", "12:59")], []),
    ).toEqual([]);
  });

  it("needs 2 weeks: one week, or a week the gap was used, is nothing", () => {
    expect(gapInsights(split("2026-11-16"), [])).toEqual([]);
    const used = [{ started_at: at("2026-11-09", "12:20"), ended_at: at("2026-11-09", "12:45") }];
    expect(gapInsights([...split("2026-11-09"), ...split("2026-11-16")], used)).toEqual([]);
    // A session before the gap does not count as using it.
    const before = [{ started_at: at("2026-11-09", "07:00"), ended_at: at("2026-11-09", "07:30") }];
    expect(gapInsights([...split("2026-11-09"), ...split("2026-11-16")], before)).toHaveLength(1);
  });

  it("takes other blocks out of the gap, and names two jobs", () => {
    const day = (date: string) => [
      job(date, "08:00", "12:00"),
      other(date, "12:00", "13:00"), // lunch
      job(date, "14:00", "17:00", "Job B", "jobb"),
    ];
    expect(gapInsights([...day("2026-11-09"), ...day("2026-11-16")], [])[0]?.text).toBe(
      "Two short sessions fit 13:00–14:00 on Mon, between Job A and Job B. It went unused the last 2 weeks.",
    );
    // A lunch that fills the gap leaves nothing.
    const full = (date: string) => [...split(date), other(date, "12:00", "13:00")];
    expect(gapInsights([...full("2026-11-09"), ...full("2026-11-16")], [])).toEqual([]);
  });

  it("groups the weekdays of one gap", () => {
    const dates = [
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ];
    expect(
      gapInsights(
        dates.flatMap((d) => split(d)),
        [],
      )[0]?.text,
    ).toBe(
      "Two short sessions fit 12:15–13:00 on workdays, between the parts of Job A. It went unused the last 2 weeks.",
    );
    const twoDays = dates.filter(
      (d) => d.endsWith("10") || d.endsWith("12") || d.endsWith("17") || d.endsWith("19"),
    );
    expect(
      gapInsights(
        twoDays.flatMap((d) => split(d)),
        [],
      )[0]?.text,
    ).toContain("on Tue, Thu,");
  });
});
