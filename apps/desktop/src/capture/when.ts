/**
 * Reads the date and time words people put in a capture: `today`, `tomorrow`
 * (and its usual misspellings), `fri`, `next mon`, `in 3 days`, `20 dec`,
 * `dec 20 2027`, `20/12`, `2026-12-03`, `the 28th`, `this weekend`, `next week`,
 * `10am`, `10:30`, `at 3`, `at 1530`, `15:00`, `tomorrow 9`, `in 30 min`,
 * `for 45 min`. Small and deterministic on purpose (ADR-0005):
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
  /** Minutes after the date's midnight; 24:00 or more for 00:00–03:00, which belongs to the logical day before. */
  minutes?: number;
  /** How long, from a range (`3-4:30pm`) or `for 45 min`. */
  durationMin?: number;
  /** A part of the day instead of a time: `tomorrow morning`, `tonight`. */
  window?: DayWindow;
  /** `tonight` said after midnight: the calendar day's evening, not the logical tomorrow (F86). */
  tonight?: boolean;
  /** The text with the date and time words removed. */
  rest: string;
}

export type DayWindow = "morning" | "afternoon" | "evening";

/** Where each part of the day starts and ends, in minutes after midnight (time-first §1 rule 2). */
export const WINDOWS: Record<DayWindow, { start: number; end: number }> = {
  morning: { start: 6 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 22 * 60 },
};

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

/** A month/day in the year written ("25 dec 2027"), else the next one. */
function dayIn(
  today: string,
  month: number,
  day: number,
  year: string | undefined,
  past: boolean,
): string | undefined {
  if (!year) return monthDay(today, month, day, past);
  return isValidDate(Number(year), month, day) ? format(Number(year), month, day) : undefined;
}

/** "the 28th": the next date with that day of the month (the last one, for spending). */
function nthOfMonth(today: string, day: number, past: boolean): string | undefined {
  if (day < 1 || day > 31) return undefined;
  const [y, m] = parts(today);
  for (let step = 0; step <= 12; step++) {
    const index = y * 12 + (m - 1) + (past ? -step : step);
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
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

/**
 * An hour as written. `literal` is the 24-hour clock ("01:00", zero-padded):
 * 1–6 is then the night, not the afternoon.
 */
function readHour(
  hour: number,
  ampm: string | undefined,
  style: ClockStyle,
  literal = false,
): number | undefined {
  if (!ampm && literal) return hour <= 23 ? hour : undefined;
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

const AMPM = String.raw`(am|pm|a\.m\.|p\.m\.)`;
/** `3-4:30pm`, `3pm-4pm`, `from 3pm to 4pm`, `15:00-16:00`, `from 9 to 5`. */
const RANGE = new RegExp(
  String.raw`\s(?:(from|at)\s+)?(\d{1,2})(?::(\d{2}))?\s*${AMPM}?(?:\s*[-–]\s*|\s+(?:to|till|until)\s+)(\d{1,2})(?::(\d{2}))?\s*${AMPM}?(?=\s)`,
  "i",
);
/** `for 45 min`, `for 2h`, `for an hour`: how long, with or without a time. */
const FOR_DURATION = /\s+for\s+(\d+(?:\.\d+)?|an?|one)\s*(m|mins?|minutes?|h|hrs?|hours?)(?=\s)/i;
/** `in 30 min`, `in an hour`, `in 2 hours`: that long from now. */
const IN_DURATION = /\sin\s+(\d{1,3}|an?|one)\s*(m|mins?|minutes?|h|hrs?|hours?)(?=\s)/i;
/** `tomorrow` and the ways it gets mistyped: a fixed list, so reading stays deterministic. */
const TOMORROW = String.raw`tomm?orr?ow|tmrw|tmr|2moro|2morr?ow`;
const WINDOW_WORD = new RegExp(
  String.raw`\s(?:(this|in\s+the|${TOMORROW}|today)\s+)?(morning|afternoon|evening|tonight)(?=\s)`,
  "i",
);
const IS_TOMORROW = new RegExp(String.raw`^(?:${TOMORROW})$`, "i");
const ENDS_WITH_WEEKDAY =
  /(?:^|\s)(?:sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\s*$/i;

/** Minutes from `start` to `end`, past midnight when `end` is earlier. */
const spanOf = ([start, end]: [number, number]) =>
  end > start ? end - start : end + 24 * 60 - start;

/**
 * A range's two ends in minutes; the side without am/pm borrows the other's.
 * With no am/pm at all, a zero-padded hour ("01:00") is the 24-hour clock,
 * and so is the reading that makes the shorter span: "23:00-1:00" is two
 * hours past midnight, not fourteen.
 */
function readRange(m: RegExpExecArray, style: ClockStyle): [number, number] | undefined {
  const [, lead, h1, m1, ap1, h2, m2, ap2] = m;
  // Bare numbers ("chapters 3-4") are only a time with `from`, a colon or am/pm.
  if (!lead?.toLowerCase().startsWith("from") && !m1 && !m2 && !ap1 && !ap2) return undefined;
  const minute = (text: string | undefined) => (text ? Number(text) : 0);
  if (minute(m1) > 59 || minute(m2) > 59) return undefined;
  const at = (
    hour: string | undefined,
    mins: string | undefined,
    ampm: string | undefined,
    literal = false,
  ) => {
    const h = readHour(
      Number(hour),
      ampm?.toLowerCase(),
      ampm || mins ? "western" : style,
      literal || /^0\d/.test(hour ?? ""),
    );
    return h === undefined ? undefined : h * 60 + minute(mins);
  };
  if (!ap1 && !ap2) {
    const start = at(h1, m1, undefined);
    const end = at(h2, m2, undefined);
    if (start === undefined || end === undefined) return undefined;
    const start24 = at(h1, m1, undefined, true);
    const end24 = at(h2, m2, undefined, true);
    if (start24 === undefined || end24 === undefined) return [start, end];
    return spanOf([start24, end24]) < spanOf([start, end]) ? [start24, end24] : [start, end];
  }
  const flip = (ampm: string) => (ampm.toLowerCase().startsWith("a") ? "pm" : "am");
  let end = at(h2, m2, ap2 ?? ap1);
  let start = at(h1, m1, ap1 ?? ap2);
  if (start === undefined || end === undefined) return undefined;
  // "11-1pm" is 11:00 to 13:00; "11am-1" is 11:00 to 13:00.
  if (!ap1 && ap2 && start > end) start = at(h1, m1, flip(ap2)) ?? start;
  if (ap1 && !ap2 && end <= start) end = at(h2, m2, flip(ap1)) ?? end;
  return [start, end];
}

export interface ReadOptions {
  /** Read day words backwards: "mon" is last Monday, "20 dec" the last 20 Dec. For spending. */
  past?: boolean;
  /** The line starts with a task verb, so a bare "morning" at its end is when to do it. */
  taskLine?: boolean;
}

/** A day named anywhere in the text: today, tomorrow, a weekday, `in 3 days`, `20 dec`, `20/12`. */
const MONTH_NAMES = Object.keys(MONTHS).join("|");
const NAMES_A_DAY = new RegExp(
  String.raw`\b\d{4}-\d{2}-\d{2}\b|\b(?:today|tdy|${TOMORROW}|yesterday|yday|${Object.keys(WEEKDAY_WORDS).join("|")})\b|\bin\s+\d{1,3}\s+(?:days?|weeks?)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH_NAMES})\b|\b(?:${MONTH_NAMES})\s+\d{1,2}\b`,
  "i",
);

export function readWhen(
  text: string,
  nowMs: number,
  style: ClockStyle = "western",
  { past = false, taskLine = false }: ReadOptions = {},
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

  let durationMin: number | undefined;
  let window: DayWindow | undefined;
  /** Where `fri afternoon` had its part of the day, so `fri` still counts mid-line. */
  let windowAfterDayAt: number | undefined;
  /** Where a day word was taken out, so `tomorrow 9` can read the hour after it. */
  let dayAt: number | undefined;
  /** "tonight" said after midnight: already the calendar evening, not a night to shift. */
  let calendarEvening = false;

  // A range first, so its end isn't left behind in the title (time-first §2).
  take(RANGE, (m) => {
    const range = readRange(m, style);
    if (!range) return false;
    const length = spanOf(range);
    if (length > 18 * 60) return false;
    minutes = range[0];
    durationMin = length;
    return true;
  });

  // Times first, so "10am" isn't read as a day.
  if (minutes === undefined)
    take(/\s(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?=\s)/i, (m) => {
      // "01:00" is the 24-hour clock: one at night.
      const hour = readHour(
        Number(m[1]),
        m[3]?.toLowerCase(),
        m[3] ? style : "western",
        /^0\d/.test(m[1] ?? ""),
      );
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
    // "at 1530": four digits are the 24-hour clock. Only after "at", so "rent 1530" stays money.
    take(/\sat\s+(\d{2})(\d{2})(?=\s)/i, (m) => {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) return false;
      minutes = hour * 60 + minute;
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
  /** Set when the date and time are an exact moment ("in 30 min"), already on its logical day. */
  let exact = false;
  if (minutes === undefined && !past) {
    take(IN_DURATION, (m) => {
      const count = /^\d/.test(m[1] ?? "") ? Number(m[1]) : 1;
      const length = (m[2]?.toLowerCase().startsWith("m") ? 1 : 60) * count;
      if (length <= 0 || length > 24 * 60) return false;
      const target = nowMs + length * 60_000;
      const day = logicalDate(target);
      date = day;
      minutes = Math.round((target - localToEpoch(day, 0)) / 60_000);
      exact = true;
      return true;
    });
  }
  // A length, with or without a time: "call mom for 20 minutes" is how long.
  if (durationMin === undefined) {
    take(FOR_DURATION, (m) => {
      const count = /^\d/.test(m[1] ?? "") ? Number(m[1]) : 1;
      const length = Math.round((m[2]?.toLowerCase().startsWith("m") ? 1 : 60) * count);
      if (length <= 0 || length > 18 * 60) return false;
      durationMin = length;
      return true;
    });
  }

  // A part of the day: `tomorrow morning`, `this evening`, `fri afternoon`,
  // `tonight`. A bare "morning" mid-line ("morning run") stays a word.
  take(WINDOW_WORD, (m) => {
    const word = m[2]?.toLowerCase() ?? "";
    const lead = m[1]?.toLowerCase().replace(/\s+/g, " ");
    const atEnd = rest.slice(m.index + m[0].length).trim() === "";
    const afterDay = ENDS_WITH_WEEKDAY.test(rest.slice(0, m.index));
    if (word !== "tonight" && !lead && !atEnd && !afterDay) return false;
    // A bare "morning" / "in the evening" ending the line ("good morning",
    // "watched a movie in the evening") is a part of the day only on a task
    // line, a line that names a day or time, or a line that is only the word.
    const bare = word !== "tonight" && (!lead || lead === "in the") && !afterDay;
    const others = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).trim();
    if (bare && others && !taskLine && minutes === undefined && !NAMES_A_DAY.test(others))
      return false;
    if (afterDay && !lead) windowAfterDayAt = m.index;
    // "tonight" said at 01:00 is the coming evening, not the one just gone.
    const evening = word === "tonight" || (word === "evening" && lead === "this");
    if (evening && calendarToday !== today) {
      date = calendarToday;
      calendarEvening = true;
    } else if (word === "tonight" || lead === "this" || lead === "today") date = today;
    else if (lead && IS_TOMORROW.test(lead)) date = addDays(today, 1);
    // A time you gave wins over the part of the day.
    if (minutes === undefined) window = word === "tonight" ? "evening" : (word as DayWindow);
    return true;
  });

  if (!date)
    take(/\s(today|tdy)(?=\s)/i, (m) => {
      date = today;
      dayAt = m.index;
      return true;
    });
  if (!date)
    take(new RegExp(String.raw`\s(${TOMORROW})(?=\s)`, "i"), (m) => {
      date = addDays(today, 1);
      dayAt = m.index;
      return true;
    });
  if (!date) {
    take(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)(?=\s)/i, (m) => {
      const n = Number(m[1]);
      date = addDays(today, m[2]?.toLowerCase().startsWith("week") ? n * 7 : n);
      return true;
    });
  }
  if (!date) take(/\s(yesterday|yday)(?=\s)/i, () => ((date = addDays(today, -1)), true));
  if (!date && !past) {
    // "this weekend": the coming Saturday (today at the weekend); "next weekend" the one after.
    take(/\s(this|next|the)\s+weekend(?=\s)/i, (m) => {
      const day = weekday(today);
      const ahead = day === 0 ? 0 : 6 - day;
      const next = m[1]?.toLowerCase() === "next";
      date = addDays(today, next ? (day === 0 ? 6 : ahead + 7) : ahead);
      return true;
    });
  }
  if (!date && !past) {
    // "next week": its Monday.
    take(/\snext\s+week(?=\s)/i, () => {
      date = addDays(today, 7 - ((weekday(today) + 6) % 7));
      return true;
    });
  }
  if (!date) {
    // A weekday counts when it follows on/next/this/by or ends the line, so
    // "the sun is out" stays text while "gym sat" and "on sun" are dates.
    take(/\s(?:(next|this|on|by)\s+)?([a-z]+)(?=\s)/i, (m) => {
      const target = WEEKDAY_WORDS[m[2]?.toLowerCase() ?? ""];
      if (target === undefined) return false;
      const after = rest.slice(m.index + m[0].length).trim();
      // "call bank fri 4": a bare hour after it still ends the line.
      const isLast = after === "" || (!past && minutes === undefined && /^\d{1,2}$/.test(after));
      const prefix = m[1]?.toLowerCase();
      const beforeWindow = windowAfterDayAt === m.index + m[0].length;
      if (!prefix && !isLast && !beforeWindow) return false;
      dayAt = m.index;
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
  // "25 dec 2027" / "dec 25, 2027": a year only when it is plausible for a plan
  // (this year to five on) and never on spending, so "taxi 3 nov 1200" keeps
  // its 1,200 as the amount. Then the same forms without a year.
  const dayFirst = String.raw`\s(?:on\s+)?(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})`;
  const monthFirst = String.raw`\s(?:on\s+)?([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?`;
  const YEAR = String.raw`,?\s+(\d{4})`;
  const plausibleYear = (text: string | undefined) => {
    const year = Number(text);
    const [thisYear] = parts(today);
    return !past && year >= thisYear && year <= thisYear + 5;
  };
  const readMonthDay = (withYear: boolean, monthFirstOrder: boolean) =>
    take(
      new RegExp(
        `${monthFirstOrder ? monthFirst : dayFirst}${withYear ? YEAR : ""}${String.raw`(?=\s)`}`,
        "i",
      ),
      (m) => {
        const [monthText, dayText] = monthFirstOrder ? [m[1], m[2]] : [m[2], m[1]];
        const month = MONTHS[monthText?.toLowerCase() ?? ""];
        if (!month) return false;
        if (withYear && !plausibleYear(m[3])) return false;
        date = dayIn(today, month, Number(dayText), withYear ? m[3] : undefined, past);
        return date !== undefined;
      },
    );
  for (const withYear of [true, false])
    for (const order of [false, true]) if (!date) readMonthDay(withYear, order);
  if (!date) {
    // ISO, as copied from a form or an email: 2026-12-03.
    take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!isValidDate(y, mo, d)) return false;
      date = format(y, mo, d);
      return true;
    });
  }
  if (!date) {
    // "on the 28th", "by the 28th", or "the 28th" ending the line: the next
    // 28th (the last one, for spending). "read the 5th chapter" stays text.
    const nth =
      /\s(?:(?:on|by)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?|the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s*$))(?=\s)/i;
    take(nth, (m) => {
      date = nthOfMonth(today, Number(m[1] ?? m[2]), past);
      return date !== undefined;
    });
  }

  // "tomorrow 9", "fri 4": a bare hour right after the day, ending the line.
  if (date && dayAt !== undefined && minutes === undefined && !past) {
    const hour = /^\s+(\d{1,2})\s*$/.exec(rest.slice(dayAt));
    const read = hour ? readHour(Number(hour[1]), undefined, style) : undefined;
    if (read !== undefined) {
      minutes = read * 60;
      rest = rest.slice(0, dayAt) + " ";
    }
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

  // A day you named with a time before 03:00 is that day's night (the
  // logical day runs to 03:00): "tomorrow 2am" comes after tomorrow's
  // evening, written 26:00 like a bare "at 1am" after midnight. Every date set
  // so far was named ("12 dec" and "12/12" alike); a time alone is handled below.
  if (date && minutes !== undefined && minutes < 3 * 60 && !exact && !calendarEvening)
    minutes += 24 * 60;

  // A time with no day means today, or tomorrow if that time has passed. A
  // range or a part of the day counts as today until it ends: "read from 3pm
  // to 4pm" typed at 15:12 is today's 15:00 (time-first §2).
  if (!date) {
    const end =
      minutes !== undefined
        ? minutes + (durationMin ?? 0)
        : window !== undefined
          ? WINDOWS[window].end
          : undefined;
    if (end !== undefined) {
      date = localToEpoch(calendarToday, end) > nowMs ? calendarToday : addDays(calendarToday, 1);
      // "at 1am" said at 00:30 is due on the logical day it falls in (it starts at 03:00).
      // Kept as minutes past that day's midnight (25:00), so the moment is unchanged.
      if (minutes !== undefined && logicalDate(localToEpoch(date, minutes)) !== date) {
        date = addDays(date, -1);
        minutes += 24 * 60;
      }
    }
  }

  const result: When = { rest: rest.replace(/\s+/g, " ").trim() };
  if (date) result.date = date;
  if (minutes !== undefined) result.minutes = minutes;
  if (durationMin !== undefined) result.durationMin = durationMin;
  if (window !== undefined) result.window = window;
  if (calendarEvening) result.tonight = true;
  return result;
}

export function weekdayName(date: string): string {
  const name = WEEKDAYS[weekday(date)] ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
