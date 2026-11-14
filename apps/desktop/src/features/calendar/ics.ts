/**
 * Reading a Google Calendar feed (plan Appendix A; R-CAL-01) with ical.js:
 * repeating events expanded (RRULE, EXDATE, RDATE), a moved instance
 * replaces its slot, cancelled ones are dropped, timed events follow their
 * time zone and all-day events stay on their date. Only yesterday to a
 * month ahead is kept. Pure and tested with fixtures.
 */
import ICAL from "ical.js";

import { type Op } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { localToEpoch } from "../../capture/when";
import { shiftDate } from "../plan/dayplan";

export interface Occurrence {
  id: string;
  ical_uid: string;
  summary: string;
  location: string | null;
  start_at: number;
  end_at: number;
  local_date: string;
  all_day: number;
}

export const WINDOW_BACK_DAYS = 1;
/** A month ahead: enough to plan, and a repeating event never fills a year. */
export const WINDOW_AHEAD_DAYS = 31;
/** A runaway rule (every minute) can't hang the app: steps near the window… */
const MAX_STEPS = 5000;
/** …and all steps (about half a second of work); fastStart skips most of them. */
const MAX_TOTAL_STEPS = 20_000;
/** A moved instance can sit up to this far from its original slot and still be seen. */
const MOVE_MARGIN_MS = 31 * 24 * 60 * 60 * 1000;
const DAY_START_MIN = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export class FeedError extends Error {
  constructor(public code: "bad_payload" | "parse_error") {
    super(code);
  }
}

export function windowOf(today: string): { from: string; to: string } {
  return { from: shiftDate(today, -WINDOW_BACK_DAYS), to: shiftDate(today, WINDOW_AHEAD_DAYS) };
}

function text(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The occurrences that start between `from` and `to` (logical dates, inclusive). */
export function parseFeed(feed: string, from: string, to: string): Occurrence[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(feed));
  } catch {
    throw new FeedError("bad_payload");
  }
  if (root.name !== "vcalendar") throw new FeedError("bad_payload");

  // Zones are global in ical.js: start each feed from the built-in ones.
  ICAL.TimezoneService.reset();
  for (const zone of root.getAllSubcomponents("vtimezone"))
    ICAL.TimezoneService.register(new ICAL.Timezone(zone));

  // Masters by UID, and the instances that change one occurrence of them.
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const component of root.getAllSubcomponents("vevent")) {
    // Exceptions are related by hand below, only to the master with their
    // UID (ical.js would otherwise attach every exception in the file).
    const event = new ICAL.Event(component, { strictExceptions: true, exceptions: [] });
    if (!event.uid) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master) master.relateException(exception);
    else masters.set(`${exception.uid}#${exception.recurrenceId.toString()}`, exception);
  }

  // The logical day starts at 03:00 (rule 4).
  const windowStart = localToEpoch(from, DAY_START_MIN);
  const windowEnd = localToEpoch(shiftDate(to, 1), DAY_START_MIN);
  const out = new Map<string, Occurrence>();

  const add = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, item: ICAL.Event) => {
    if (text(item.component, "status")?.toUpperCase() === "CANCELLED") return;
    const allDay = start.isDate;
    const date = allDay ? start.toString().slice(0, 10) : "";
    const startAt = allDay ? localToEpoch(date, 0) : start.toJSDate().getTime();
    const endAt = allDay
      ? localToEpoch(end.isDate ? end.toString().slice(0, 10) : shiftDate(date, 1), 0)
      : end.toJSDate().getTime();
    if (startAt >= windowEnd || Math.max(endAt, startAt) < windowStart) return;
    const localDate = allDay ? date : logicalDate(startAt);
    if (localDate < from || localDate > to) return;
    const id = `${event.uid}|${startAt}`;
    out.set(id, {
      id,
      ical_uid: event.uid,
      summary: text(item.component, "summary") ?? "Busy",
      location: text(item.component, "location"),
      start_at: startAt,
      end_at: Math.max(endAt, startAt),
      local_date: localDate,
      all_day: allDay ? 1 : 0,
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate ?? event.startDate, event);
      continue;
    }
    // Walk the rule by each instance's original slot; a moved instance is
    // placed by add() at its new time.
    const iterator = event.iterator(fastStart(event, windowStart - MOVE_MARGIN_MS) ?? undefined);
    let near = 0;
    for (
      let total = 0, next = iterator.next();
      next && total < MAX_TOTAL_STEPS && near < MAX_STEPS;
      total++, next = iterator.next()
    ) {
      const slot = next.toJSDate().getTime();
      if (slot >= windowEnd + MOVE_MARGIN_MS) break;
      if (slot < windowStart - MOVE_MARGIN_MS) continue;
      near++;
      const details = event.getOccurrenceDetails(next);
      add(event, details.startDate, details.endDate, details.item);
    }
  }
  return [...out.values()].sort((a, b) => a.start_at - b.start_at);
}

const DAY_UNITS: Record<string, number> = { DAILY: 1, WEEKLY: 7 };
const SUB_DAY_SECONDS: Record<string, number> = { HOURLY: 3600, MINUTELY: 60, SECONDLY: 1 };
const PLAIN_PARTS = new Set(["BYDAY", "WKST"]);

/**
 * A later start for a long-running rule, so it isn't walked from years ago:
 * the original start moved forward by whole periods to just before `beforeMs`.
 * Only for rules where that gives the same occurrences: one RRULE, no COUNT
 * (it counts from the real start), no RDATE, nothing but BYDAY (whole weeks,
 * and only when the start is itself on one of those days), and for rules
 * under a day only in UTC (a DST change would shift them). Otherwise null.
 */
export function fastStart(event: ICAL.Event, beforeMs: number): ICAL.Time | null {
  const component = event.component;
  const rules = component.getAllProperties("rrule");
  if (rules.length !== 1 || component.hasProperty("rdate")) return null;
  const rule = rules[0]?.getFirstValue() as ICAL.Recur | undefined;
  if (!rule || rule.count || !rule.freq) return null;
  const interval = rule.interval || 1;
  const start = event.startDate;
  const startMs = start.toJSDate().getTime();
  if (beforeMs <= startMs) return null;
  const parts = Object.keys(rule.parts);
  if (parts.some((part) => !PLAIN_PARTS.has(part))) return null;
  const byDay = (rule.parts.BYDAY ?? []) as string[];
  if (byDay.some((day) => /\d/.test(day))) return null;
  if (byDay.length > 0) {
    const names = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    if (!byDay.includes(names[start.dayOfWeek() - 1] ?? "")) return null;
  }

  const days = DAY_UNITS[rule.freq];
  const seconds = SUB_DAY_SECONDS[rule.freq];
  const shifted = start.clone();
  if (days !== undefined) {
    // With BYDAY, a whole number of weeks keeps the weekday.
    const stepDays = byDay.length > 0 && days === 1 ? 7 * interval : days * interval;
    const steps = Math.floor((beforeMs - startMs) / (stepDays * DAY_MS));
    if (steps < 1) return null;
    shifted.adjust(steps * stepDays, 0, 0, 0);
  } else if (seconds !== undefined) {
    if (byDay.length > 0 || start.isDate || start.zone !== ICAL.Timezone.utcTimezone) return null;
    const stepSeconds = seconds * interval;
    const steps = Math.floor((beforeMs - startMs) / (stepSeconds * 1000));
    if (steps < 1) return null;
    shifted.adjust(0, 0, 0, steps * stepSeconds);
  } else return null;
  // Past UNTIL: nothing left to find, walking from the real start is cheap enough.
  if (rule.until && shifted.compare(rule.until) > 0) return null;
  return shifted;
}

export const WINDOW_SQL = `SELECT id, ical_uid, summary, location, start_at, end_at, local_date, all_day
  FROM cal_occurrences WHERE deleted_at IS NULL AND local_date >= ? AND local_date <= ?`;

export interface SyncPlan {
  ops: Op[];
  /** Deletions held back because the feed shrank by more than half. */
  held: boolean;
  changed: boolean;
}

/**
 * The writes that make the window match the feed. A feed that suddenly has
 * less than half the events (a broken or wrong calendar) adds and updates,
 * but deletes nothing until you say so.
 */
export function syncOps(
  fresh: Occurrence[],
  existing: Occurrence[],
  allowShrink = false,
): SyncPlan {
  const keep = new Set(fresh.map((occurrence) => occurrence.id));
  const gone = existing.filter((row) => !keep.has(row.id));
  const held = !allowShrink && existing.length >= 4 && fresh.length < existing.length / 2;
  const stored = new Map(existing.map((row) => [row.id, row]));
  // Only new or edited occurrences are written (each write is logged).
  const ops: Op[] = fresh
    .filter((occurrence) => !same(occurrence, stored.get(occurrence.id)))
    .map((occurrence) => {
      const { id, ...values } = occurrence;
      return { op: "upsert", table: "cal_occurrences", id, values };
    });
  const deletes = held ? [] : gone;
  for (const row of deletes) ops.push({ op: "delete", table: "cal_occurrences", id: row.id });
  return { ops, held, changed: ops.length > 0 };
}

function same(a: Occurrence, b: Occurrence | undefined): boolean {
  return (
    b !== undefined &&
    a.ical_uid === b.ical_uid &&
    a.summary === b.summary &&
    a.location === b.location &&
    a.start_at === b.start_at &&
    a.end_at === b.end_at &&
    a.local_date === b.local_date &&
    a.all_day === b.all_day
  );
}
