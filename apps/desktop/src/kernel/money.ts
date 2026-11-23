/**
 * Money is stored as integer santim (1 ETB = 100 santim) and never as a float
 * (plan §5.1, §5.4). Amounts are parsed from text and formatted for display here.
 */

/** Integer santim. */
export type Santim = number;

export const SANTIM_PER_BIRR = 100;

const CURRENCY_WORDS = /\b(etb|birr|br)\b\.?/gi;

/**
 * Parses an amount the way people type it: `350`, `1,200`, `12,000.50`,
 * `12k`, `1.5k`, `ETB 350`, `350 birr`, `350br`. Returns santim, or null when
 * the text is not a plain amount (letters left over, three decimals, empty).
 */
export function parseAmount(text: string): Santim | null {
  let cleaned = text.trim().toLowerCase();
  cleaned = cleaned.replace(/(\d)(etb|birr|br)\b/g, "$1 ").replace(CURRENCY_WORDS, "");
  cleaned = cleaned.replace(/[\s,]/g, "");

  let multiplier = 1;
  if (cleaned.endsWith("k")) {
    multiplier = 1000;
    cleaned = cleaned.slice(0, -1);
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, whole = "", fraction = ""] = match;

  const santim = Number(whole) * SANTIM_PER_BIRR + Number(fraction.padEnd(2, "0"));
  const total = santim * multiplier;
  return Number.isSafeInteger(total) ? total : null;
}

const groupFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The currencies you can keep an account in; ETB first. Minor units are 1/100 in all. */
export const CURRENCIES = ["ETB", "USD", "EUR", "GBP"] as const;

/** Symbols written before the amount ("$1,200.50"); others take a code after it. */
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/**
 * Formats minor units for display: `12,000 ETB`, with santim only when
 * non-zero (`12,000.50 ETB`). Dollars, euros and pounds take their symbol
 * (`$1,200.50`, `€50`, `£20`); any other code goes after (`1,200.50 CHF`).
 * Negative amounts get a leading minus.
 */
export function formatAmount(santim: Santim, currency = "ETB"): string {
  if (!Number.isSafeInteger(santim)) throw new RangeError(`Not an integer amount: ${santim}`);
  const sign = santim < 0 ? "-" : "";
  const abs = Math.abs(santim);
  const birr = Math.floor(abs / SANTIM_PER_BIRR);
  const rest = abs % SANTIM_PER_BIRR;
  const fraction = rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`;
  const number = `${groupFormatter.format(birr)}${fraction}`;
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${number}` : `${sign}${number} ${currency}`;
}

/** The amount without its unit, for placeholders and short lines ("12,000", "1,200.50"). */
export function formatNumber(santim: Santim): string {
  return formatAmount(santim, "").trimEnd();
}
