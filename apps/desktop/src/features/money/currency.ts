/**
 * Currencies (docs/proposals/time-first.md §3). Every amount stays in its own
 * currency, in minor units (cents for USD). Totals convert at a rate you set
 * in `money.rates`: 1 unit = rate ETB. Integer maths only: ETB minor =
 * round(minor × rate). Money with no rate is left out of totals, and the
 * page says so. Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim } from "../../kernel/money";

export const HOME = "ETB";
export const RATES_KEY = "money.rates";
export const RATES_SQL = `SELECT value_json FROM core_settings WHERE key = '${RATES_KEY}'`;

export interface Rate {
  /** ETB for one unit, as typed: "132.50". */
  rate: string;
  /** The logical date it was set. */
  set_on: string;
}

export type Rates = Record<string, Rate>;

const RATE_TEXT = /^(\d{1,6})(?:\.(\d{1,4}))?$/;

/** A rate as an integer and its scale ("132.50" → 13250 / 100), or null. */
function rateParts(text: string): { num: number; scale: number } | null {
  const match = RATE_TEXT.exec(text.trim());
  if (!match) return null;
  const [, whole = "", fraction = ""] = match;
  const num = Number(`${whole}${fraction}`);
  if (num <= 0) return null;
  return { num, scale: 10 ** fraction.length };
}

export function readRates(json: string | null | undefined): Rates {
  try {
    const value = JSON.parse(json ?? "null") as unknown;
    if (!value || typeof value !== "object") return {};
    const rates: Rates = {};
    for (const [code, entry] of Object.entries(value as Record<string, unknown>)) {
      const { rate, set_on } = (entry ?? {}) as { rate?: unknown; set_on?: unknown };
      if (typeof rate === "string" && rateParts(rate) && typeof set_on === "string")
        rates[code] = { rate, set_on };
    }
    return rates;
  } catch {
    return {};
  }
}

export function checkRate(text: string): string | null {
  return rateParts(text) ? null : "A rate like 132.50 (birr for one unit).";
}

/** Sets a rate, dated today; an empty rate removes it. */
export function rateOps(rates: Rates, currency: string, text: string, today: string): Op[] {
  const next: Rates = Object.fromEntries(
    Object.entries(rates).filter(([code]) => code !== currency),
  );
  if (text.trim()) next[currency] = { rate: text.trim(), set_on: today };
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: RATES_KEY,
      values: { value_json: JSON.stringify(next) },
    },
  ];
}

/** Minor units of `currency` in ETB minor units, or null without a rate. */
export function toEtb(
  minor: Santim,
  currency: string | null | undefined,
  rates: Rates,
): Santim | null {
  if (!currency || currency === HOME) return minor;
  const entry = rates[currency];
  const parts = entry ? rateParts(entry.rate) : null;
  if (!parts) return null;
  const abs = Math.abs(minor) * parts.num;
  // Half up, in integers: (2·a + s) div (2·s).
  const etb = Math.floor((2 * abs + parts.scale) / (2 * parts.scale));
  if (!Number.isSafeInteger(etb)) return null;
  return minor < 0 ? -etb : etb;
}

/** What a set of totals converted, and what it had to leave out. */
export interface Conversion {
  /** Foreign currencies that were converted. */
  used: Set<string>;
  /** Left out for want of a rate: the sum per currency. */
  missing: Map<string, Santim>;
}

export const newConversion = (): Conversion => ({ used: new Set(), missing: new Map() });

/** Converts one amount and remembers what happened, for the notes. */
export function convert(
  conversion: Conversion,
  rates: Rates,
  minor: Santim,
  currency: string | null | undefined,
): Santim | null {
  const etb = toEtb(minor, currency, rates);
  if (!currency || currency === HOME) return etb;
  if (etb === null)
    conversion.missing.set(currency, (conversion.missing.get(currency) ?? 0) + minor);
  else conversion.used.add(currency);
  return etb;
}

/** Joins what several totals converted. */
export function mergeConversions(...all: Conversion[]): Conversion {
  const merged = newConversion();
  for (const one of all) {
    for (const code of one.used) merged.used.add(code);
    for (const [code, minor] of one.missing)
      merged.missing.set(code, (merged.missing.get(code) ?? 0) + minor);
  }
  return merged;
}

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const dayMonth = (date: string) => DAY_MONTH.format(Date.parse(`${date}T00:00:00Z`));

export interface ConversionNotes {
  /** True when a foreign amount went into the total: show "≈". */
  approx: boolean;
  /** "at 132.50 (23 Nov)", or per currency when several were used. */
  rate: string | null;
  /** "Left out: $300 (no USD rate yet; set one under Accounts)." */
  missing: string | null;
}

export function conversionNotes(conversion: Conversion, rates: Rates): ConversionNotes {
  const used = [...conversion.used].sort();
  const at = (code: string) => {
    const entry = rates[code];
    return entry ? `at ${entry.rate} (${dayMonth(entry.set_on)})` : "";
  };
  const rate =
    used.length === 0
      ? null
      : used.length === 1
        ? at(used[0] ?? "")
        : used.map((code) => `${code} ${at(code)}`).join(" · ");
  const missingCodes = [...conversion.missing.keys()].sort();
  const missing =
    missingCodes.length === 0
      ? null
      : `Left out: ${missingCodes
          .map((code) => formatAmount(conversion.missing.get(code) ?? 0, code))
          .join(", ")} (no ${missingCodes.join(" or ")} rate yet; set one under Accounts).`;
  return { approx: used.length > 0, rate, missing };
}

/** "≈ " before a total that holds converted money. */
export const approxMark = (notes: Pick<ConversionNotes, "approx">) => (notes.approx ? "≈ " : "");

/**
 * SQL for a row's currency, with its account joined as `acc`: a currency the
 * row names itself (`$20 lunch` landing in cash) wins; a row left in birr
 * (the column's default) takes its account's currency, so a capture into
 * Wise is dollars even when it wrote none.
 */
export const rowCurrencySql = (row: string) =>
  `CASE WHEN ${row}.currency <> 'ETB' THEN ${row}.currency ELSE COALESCE(acc.currency, 'ETB') END`;
