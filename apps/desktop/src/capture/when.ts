/**
 * Reads the date and time words people put in a capture: `today`, `tomorrow`,
 * `fri`, `next mon`, `in 3 days`, `20 dec`, `dec 20`, `20/12`, `10am`,
 * `10:30`, `at 3`, `15:00`. Small and deterministic on purpose (ADR-0005):
 * the capture box loads it on every open.
 *
 * Dates are local (Africa/Addis_Ababa, UTC+3, no daylight saving).
 */
import { HOME_UTC_OFFSET_MIN, localDate, logicalDate } from "../kernel/dates";

/** How "at 3" (no am/pm) is read: 15:00, or the Ethiopian clock's 3 o'clock = 09:00. */
export type ClockStyle = "western" | "ethiopian";

export interface When {
  /** Local date, YYYY-MM-DD. */
  date?: string;
  /** Minutes after local midnight. */
  minutes?: number;
  /** The text with the date and time words removed. */
  rest: string;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(date: string): [number, number, number] {
  const [y = "0", m = "0", d = "0"] = date.split("-");
  return [Number(y), Number(m), Number(d)];
}

function format(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return format(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function weekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isValidDate(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * The month/day on or after today (forward), or on or before today (past,
 * for spending). Looks up to 4 years so 29 Feb always finds a leap year.
 */
function monthDay(today: string, month: number, day: number, past: boolean): string | undefined {
  const [y] = parts(today);
  for (let step = 0; step <= 4; step++) {
    const year = past ? y - step : y + step;
    if (!isValidDate(year, month, day)) continue;
    const candidate = format(year, month, day);
    if (past ? candidate <= today : candidate >= today) return candidate;
  }
  return undefined;
}

/** Epoch ms for a local date and minutes after midnight. */
export function localToEpoch(date: string, minutes: number): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d) + (minutes - HOME_UTC_OFFSET_MIN) * 60 * 1000;
}

function readHour(hour: number, ampm: string | undefined, style: ClockStyle): number | undefined {
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    const isPm = ampm.startsWith("p");
    return (hour % 12) + (isPm ? 12 : 0);
  }
  if (hour > 23) return undefined;
  if (hour >= 13 || hour === 0) return hour;
  if (style === "ethiopian") return (hour + 6) % 24; // 3 o'clock = 09:00, 12 o'clock = 18:00
  // Western: 1–6 without am/pm are afternoon (people don't schedule 3 am);
  // 7–11 are morning; 12 is noon.
  return hour <= 6 ? hour + 12 : hour;
}

export interface ReadOptions {
  /** Read day words backwards: "mon" is last Monday, "20 dec" the last 20 Dec. For spending. */
  past?: boolean;
}

export function readWhen(
  text: string,
  nowMs: number,
  style: ClockStyle = "western",
  { past = false }: ReadOptions = {},
): When {
  // Day words follow the logical day (it starts at 03:00), so "tomorrow" said
  // at 01:00 is the coming day, not the one after (plan §5.1 rule 4).
  const today = logicalDate(nowMs);
  // A bare clock time is about the real calendar: "at 10" said at 01:30 is this morning.
  const calendarToday = localDate(nowMs);
  let rest = ` ${text} `;
  let date: string | undefined;
  let minutes: number | undefined;

  // Tries each match of `pattern` in turn; the first one `accept` takes is removed from the text.
  const take = (pattern: RegExp, accept: (match: RegExpExecArray) => boolean) => {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
    );
    for (let match = global.exec(rest); match; match = global.exec(rest)) {
      if (accept(match)) {
        rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
        return;
      }
      // The lookahead keeps the trailing space, so step past the match start.
      global.lastIndex = match.index + 1;
    }
  };

  // Times first, so "10am" isn't read as a day.
  take(/\s(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?=\s)/i, (m) => {
    const hour = readHour(Number(m[1]), m[3]?.toLowerCase(), m[3] ? style : "western");
    const minute = Number(m[2]);
    if (hour === undefined || minute > 59) return false;
    minutes = hour * 60 + minute;
    return true;
  });
  if (minutes === undefined) {
    // "at 10.30" or "10.30pm": a dot only counts as a time with "at" or am/pm,
    // so "coffee 30.50" stays money.
    take(
      /\s(?:at\s+(\d{1,2})\.(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?|(\d{1,2})\.(\d{2})\s*(am|pm|a\.m\.|p\.m\.))(?=\s)/i,
      (m) => {
        const hourText = m[1] ?? m[4];
        const minuteText = m[2] ?? m[5];
        const ampm = (m[3] ?? m[6])?.toLowerCase();
        const hour = readHour(Number(hourText), ampm, style);
        const minute = Number(minuteText);
        if (hour === undefined || minute > 59) return false;
        minutes = hour * 60 + minute;
        return true;
      },
    );
  }
  if (minutes === undefined) {
    take(/\s(?:at\s+)?(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)(?=\s)/i, (m) => {
      const hour = readHour(Number(m[1]), m[2]?.toLowerCase(), style);
      if (hour === undefined) return false;
      minutes = hour * 60;
      return true;
    });
  }
  if (minutes === undefined) {
    take(/\sat\s+(\d{1,2})(?=\s)/i, (m) => {
      const hour = readHour(Number(m[1]), undefined, style);
      if (hour === undefined) return false;
      minutes = hour * 60;
      return true;
    });
  }
  if (minutes === undefined) {
    take(/\s(noon|midday)(?=\s)/i, () => ((minutes = 12 * 60), true));
  }

  take(/\s(today|tonight|tdy)(?=\s)/i, (m) => {
    date = today;
    if (m[1]?.toLowerCase() === "tonight" && minutes === undefined) minutes = 20 * 60;
    return true;
  });
  if (!date) take(/\s(tomorrow|tmrw|tmr)(?=\s)/i, () => ((date = addDays(today, 1)), true));
  if (!date) {
    take(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)(?=\s)/i, (m) => {
      const n = Number(m[1]);
      date = addDays(today, m[2]?.toLowerCase().startsWith("week") ? n * 7 : n);
      return true;
    });
  }
  if (!date) take(/\s(yesterday|yday)(?=\s)/i, () => ((date = addDays(today, -1)), true));
  if (!date) {
    // A weekday counts when it follows on/next/this/by or ends the line, so
    // "the sun is out" stays text while "gym sat" and "on sun" are dates.
    take(/\s(?:(next|this|on|by)\s+)?([a-z]+)(?=\s)/i, (m) => {
      const target = WEEKDAY_WORDS[m[2]?.toLowerCase() ?? ""];
      if (target === undefined) return false;
      const isLast = rest.slice(m.index + m[0].length).trim() === "";
      const prefix = m[1]?.toLowerCase();
      if (!prefix && !isLast) return false;
      if (past) {
        // Spending: the most recent such day, today included.
        date = addDays(today, -((weekday(today) - target + 7) % 7));
        return true;
      }
      let ahead = (target - weekday(today) + 7) % 7;
      // "fri" on a Friday means next Friday; "this fri" means today.
      if (ahead === 0 && prefix !== "this") ahead = 7;
      date = addDays(today, ahead);
      return true;
    });
  }
  if (!date) {
    take(/\s(?:on\s+)?(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})(?=\s)/i, (m) => {
      const month = MONTHS[m[2]?.toLowerCase() ?? ""];
      if (!month) return false;
      date = monthDay(today, month, Number(m[1]), past);
      return date !== undefined;
    });
  }
  if (!date) {
    take(/\s(?:on\s+)?([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?=\s)/i, (m) => {
      const month = MONTHS[m[1]?.toLowerCase() ?? ""];
      if (!month) return false;
      date = monthDay(today, month, Number(m[2]), past);
      return date !== undefined;
    });
  }
  if (!date) {
    // Day first, as written in Ethiopia and the UK: 12/11 = 12 November.
    take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m) => {
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (m[3]) {
        const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
        if (!isValidDate(year, month, day)) return false;
        date = format(year, month, day);
        return true;
      }
      date = monthDay(today, month, day, past);
      return date !== undefined;
    });
  }

  // A time with no day means today, or tomorrow if that time has passed.
  if (minutes !== undefined && !date) {
    date = localToEpoch(calendarToday, minutes) > nowMs ? calendarToday : addDays(calendarToday, 1);
  }

  const result: When = { rest: rest.replace(/\s+/g, " ").trim() };
  if (date) result.date = date;
  if (minutes !== undefined) result.minutes = minutes;
  return result;
}

export function weekdayName(date: string): string {
  const name = WEEKDAYS[weekday(date)] ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
