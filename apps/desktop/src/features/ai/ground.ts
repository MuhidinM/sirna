/**
 * Grounding (plan §7.3; R-AI-04): every number in the AI's text must
 * appear in the facts it was sent, and every id it names must exist. A
 * reply that fails is thrown away and the template text is shown.
 */

const WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  dozen: 12,
};

/**
 * Numbers written in a text: "3 h 15", "96%", "2026-11-29", "1.5",
 * "12,000", and number words ("forty") so spelling a number out can't skip
 * the check. "one" is left out: English uses it as a pronoun too often.
 */
export function numbersIn(text: string): number[] {
  const numbers = [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0].replace(/,/g, "")),
  );
  const words = [...text.toLowerCase().matchAll(/[a-z]+/g)]
    .map((match) => WORDS[match[0]])
    .filter((value): value is number => value !== undefined);
  return [...numbers, ...words];
}

/** The numbers in `output` that the facts don't contain, as written. */
export function ungroundedNumbers(output: string[], facts: string): number[] {
  const known = new Set(numbersIn(facts));
  const missing: number[] = [];
  for (const text of output)
    for (const number of numbersIn(text)) if (!known.has(number)) missing.push(number);
  return missing;
}

export function unknownIds(ids: string[], known: Iterable<string>): string[] {
  const set = new Set(known);
  return ids.filter((id) => !set.has(id));
}

/** Null when grounded; else what was made up. */
export function groundText(output: string[], facts: string): string | null {
  const missing = ungroundedNumbers(output, facts);
  return missing.length ? `numbers not in the facts: ${missing.join(", ")}` : null;
}
