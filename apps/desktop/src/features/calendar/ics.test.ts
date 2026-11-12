import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { localToEpoch } from "../../capture/when";
import { DAY_EVENTS_SQL } from "../plan/dayplan";
import { FeedError, parseFeed, syncOps, windowOf, WINDOW_SQL } from "./ics";

const feed = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Google Inc//Google Calendar//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

const NAIROBI = [
  "BEGIN:VTIMEZONE",
  "TZID:Africa/Nairobi",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "TZNAME:EAT",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

// Monday 2026-11-09 to Monday 2026-11-23.
const FROM = "2026-11-09";
const TO = "2026-11-23";
const at = (date: string, hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return localToEpoch(date, h * 60 + m);
};

describe("reading a calendar feed", () => {
  it("reads a single timed event in UTC and in a time zone", () => {
    const occurrences = parseFeed(
      feed(
        NAIROBI,
        event(
          "UID:a",
          "SUMMARY:Dentist",
          "LOCATION:Bole",
          "DTSTART:20261110T060000Z",
          "DTEND:20261110T070000Z",
        ),
        event(
          "UID:b",
          "SUMMARY:Standup",
          "DTSTART;TZID=Africa/Nairobi:20261111T100000",
          "DTEND;TZID=Africa/Nairobi:20261111T101500",
        ),
      ),
      FROM,
      TO,
    );
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]).toMatchObject({
      ical_uid: "a",
      summary: "Dentist",
      location: "Bole",
      start_at: at("2026-11-10", "09:00"),
      end_at: at("2026-11-10", "10:00"),
      local_date: "2026-11-10",
      all_day: 0,
    });
    expect(occurrences[1]).toMatchObject({
      start_at: at("2026-11-11", "10:00"),
      end_at: at("2026-11-11", "10:15"),
    });
  });

  it("follows a foreign time zone", () => {
    const [berlin] = parseFeed(
      feed(
        BERLIN,
        event(
          "UID:c",
          "SUMMARY:Call",
          "DTSTART;TZID=Europe/Berlin:20261112T090000",
          "DTEND;TZID=Europe/Berlin:20261112T100000",
        ),
      ),
      FROM,
      TO,
    );
    // 09:00 CET is 08:00 UTC, 11:00 in Addis.
    expect(berlin?.start_at).toBe(at("2026-11-12", "11:00"));
  });

  it("expands a weekly rule, skips EXDATEs, moves an override and drops a cancelled one", () => {
    const occurrences = parseFeed(
      feed(
        event(
          "UID:gym",
          "SUMMARY:Class",
          "DTSTART:20261102T150000Z",
          "DTEND:20261102T160000Z",
          "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
          "EXDATE:20261111T150000Z",
        ),
        event(
          "UID:gym",
          "SUMMARY:Class (moved)",
          "RECURRENCE-ID:20261116T150000Z",
          "DTSTART:20261116T170000Z",
          "DTEND:20261116T180000Z",
        ),
        event(
          "UID:gym",
          "SUMMARY:Class",
          "STATUS:CANCELLED",
          "RECURRENCE-ID:20261118T150000Z",
          "DTSTART:20261118T150000Z",
          "DTEND:20261118T160000Z",
        ),
      ),
      FROM,
      TO,
    );
    expect(occurrences.map((o) => [o.local_date, o.summary])).toEqual([
      ["2026-11-09", "Class"],
      ["2026-11-16", "Class (moved)"],
      ["2026-11-23", "Class"],
    ]);
    expect(occurrences[1]?.start_at).toBe(at("2026-11-16", "20:00"));
  });

  it("keeps all-day events on their date and counts an event before 03:00 as the day before", () => {
    const occurrences = parseFeed(
      feed(
        event(
          "UID:h",
          "SUMMARY:Holiday",
          "DTSTART;VALUE=DATE:20261113",
          "DTEND;VALUE=DATE:20261114",
        ),
        event("UID:n", "SUMMARY:Late", "DTSTART:20261113T220000Z", "DTEND:20261113T230000Z"),
      ),
      FROM,
      TO,
    );
    expect(occurrences.find((o) => o.ical_uid === "h")).toMatchObject({
      local_date: "2026-11-13",
      all_day: 1,
    });
    // 01:00 on the 14th in Addis belongs to the 13th.
    expect(occurrences.find((o) => o.ical_uid === "n")?.local_date).toBe("2026-11-13");
  });

  it("keeps only the window and stops a runaway rule", () => {
    const occurrences = parseFeed(
      feed(
        event("UID:old", "SUMMARY:Old", "DTSTART:20250101T080000Z", "DTEND:20250101T090000Z"),
        event("UID:far", "SUMMARY:Far", "DTSTART:20270101T080000Z", "DTEND:20270101T090000Z"),
        event(
          "UID:tick",
          "SUMMARY:Tick",
          "DTSTART:20200101T000000Z",
          "DURATION:PT1M",
          "RRULE:FREQ=MINUTELY",
        ),
      ),
      FROM,
      TO,
    );
    expect(occurrences.filter((o) => o.ical_uid !== "tick")).toEqual([]);
  });

  it("keeps each event's exceptions to itself", () => {
    const occurrences = parseFeed(
      feed(
        event(
          "UID:A",
          "SUMMARY:Standup",
          "DTSTART:20261109T060000Z",
          "DTEND:20261109T061500Z",
          "RRULE:FREQ=DAILY;COUNT=5",
        ),
        event(
          "UID:B",
          "SUMMARY:Review",
          "DTSTART:20261109T060000Z",
          "DTEND:20261109T070000Z",
          "RRULE:FREQ=DAILY;COUNT=5",
        ),
        event(
          "UID:B",
          "SUMMARY:Review (moved)",
          "RECURRENCE-ID:20261111T060000Z",
          "DTSTART:20261111T110000Z",
          "DTEND:20261111T120000Z",
        ),
      ),
      FROM,
      TO,
    );
    const standups = occurrences.filter((o) => o.ical_uid === "A");
    expect(standups.map((o) => o.summary)).toEqual(Array(5).fill("Standup"));
    expect(standups.map((o) => o.local_date)).toContain("2026-11-11");
    expect(occurrences.filter((o) => o.summary === "Review (moved)")).toHaveLength(1);
  });

  it("goes on past an instance moved out of the window, and finds one moved in", () => {
    const occurrences = parseFeed(
      feed(
        event(
          "UID:d",
          "SUMMARY:Daily",
          "DTSTART:20261109T070000Z",
          "DTEND:20261109T080000Z",
          "RRULE:FREQ=DAILY",
        ),
        event(
          "UID:d",
          "SUMMARY:Daily",
          "RECURRENCE-ID:20261110T070000Z",
          "DTSTART:20261215T070000Z",
          "DTEND:20261215T080000Z",
        ),
        event(
          "UID:d",
          "SUMMARY:Daily (early)",
          "RECURRENCE-ID:20261130T070000Z",
          "DTSTART:20261120T120000Z",
          "DTEND:20261120T130000Z",
        ),
      ),
      FROM,
      TO,
    );
    const dates = occurrences.map((o) => o.local_date);
    expect(dates).not.toContain("2026-11-10");
    expect(dates).toContain("2026-11-11");
    expect(dates).toContain("2026-11-23");
    expect(occurrences.filter((o) => o.summary === "Daily (early)")).toHaveLength(1);
  });

  it("still expands a daily rule that began long ago", () => {
    const occurrences = parseFeed(
      feed(
        event(
          "UID:meds",
          "SUMMARY:Meds",
          "DTSTART:20100101T050000Z",
          "DTEND:20100101T051000Z",
          "RRULE:FREQ=DAILY",
        ),
      ),
      FROM,
      TO,
    );
    expect(occurrences).toHaveLength(15);
  });

  it("refuses something that isn't a calendar", () => {
    expect(() => parseFeed("<html>Sign in</html>", FROM, TO)).toThrow(FeedError);
    expect(() => parseFeed("BEGIN:VCARD\r\nEND:VCARD", FROM, TO)).toThrow(FeedError);
  });

  it("windows from yesterday to two weeks ahead", () => {
    expect(windowOf("2026-11-12")).toEqual({ from: "2026-11-11", to: "2026-11-26" });
  });
});

describe("syncing the window", () => {
  const one = (id: string) => ({
    id,
    ical_uid: id,
    summary: id,
    location: null,
    start_at: 0,
    end_at: 1,
    local_date: "2026-11-12",
    all_day: 0,
  });

  it("writes only what is new, edited or gone", () => {
    const plan = syncOps([one("a"), one("b")], [one("a"), one("c")]);
    expect(plan.held).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.ops.map((op) => [op.op, op.id])).toEqual([
      ["upsert", "b"],
      ["delete", "c"],
    ]);
    const same = syncOps([one("a")], [one("a")]);
    expect(same).toEqual({ ops: [], held: false, changed: false });
  });

  it("sees a longer meeting or a new title as a change", () => {
    const longer = syncOps([{ ...one("a"), end_at: 2 }], [one("a")]);
    expect(longer.changed).toBe(true);
    expect(longer.ops.map((op) => op.op)).toEqual(["upsert"]);
    expect(syncOps([{ ...one("a"), summary: "Renamed" }], [one("a")]).changed).toBe(true);
  });

  it("holds deletions back when the feed suddenly shrinks", () => {
    const existing = ["a", "b", "c", "d", "e"].map(one);
    const plan = syncOps([one("a")], existing);
    expect(plan.held).toBe(true);
    expect(plan.ops).toEqual([]);
    expect(syncOps([one("a")], existing, true).ops.filter((op) => op.op === "delete")).toHaveLength(
      4,
    );
  });

  it("stores occurrences the planner can read", () => {
    const db = openTestDb();
    const insert = db.prepare(
      `INSERT INTO cal_occurrences (id, ical_uid, summary, location, start_at, end_at, local_date, all_day, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0)`,
    );
    insert.run(
      "x|1",
      "x",
      "Meeting",
      at("2026-11-12", "10:00"),
      at("2026-11-12", "11:00"),
      "2026-11-12",
      0,
    );
    insert.run(
      "y|1",
      "y",
      "Holiday",
      at("2026-11-12", "00:00"),
      at("2026-11-13", "00:00"),
      "2026-11-12",
      1,
    );
    insert.run(
      "z|1",
      "z",
      "Flight",
      at("2026-11-11", "23:00"),
      at("2026-11-12", "08:00"),
      "2026-11-11",
      0,
    );
    const day = [at("2026-11-13", "03:00"), at("2026-11-12", "03:00")];
    expect(db.prepare(DAY_EVENTS_SQL).all(...day)).toEqual([
      { summary: "Flight", start_at: at("2026-11-11", "23:00"), end_at: at("2026-11-12", "08:00") },
      {
        summary: "Meeting",
        start_at: at("2026-11-12", "10:00"),
        end_at: at("2026-11-12", "11:00"),
      },
    ]);
    expect(db.prepare(WINDOW_SQL).all("2026-11-11", "2026-11-26")).toHaveLength(3);
  });
});
