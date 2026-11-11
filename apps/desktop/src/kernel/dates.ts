/** Sirna's home timezone (plan §5.1). Africa/Addis_Ababa is UTC+3 with no daylight saving. */
export const HOME_TIME_ZONE = "Africa/Addis_Ababa";

/** A logical day starts at 03:00 local time, so a 00:30 review belongs to the evening before. */
export const LOGICAL_DAY_START_HOUR = 3;

const HOUR_MS = 60 * 60 * 1000;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    // en-CA formats dates as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(epochMs: number, timeZone: string = HOME_TIME_ZONE): string {
  return formatterFor(timeZone).format(epochMs);
}

/**
 * The logical date (YYYY-MM-DD) an instant belongs to: the local date of
 * `epochMs` shifted back by the day-start hour. Reviews, daily plans, usage
 * and metrics all use this one function.
 */
export function logicalDate(
  epochMs: number,
  timeZone: string = HOME_TIME_ZONE,
  dayStartHour: number = LOGICAL_DAY_START_HOUR,
): string {
  return localDate(epochMs - dayStartHour * HOUR_MS, timeZone);
}
