import { describe, expect, it } from "vitest";

import { groundText, numbersIn, unknownIds, ungroundedNumbers } from "./ground";

const FACTS =
  "estimate 18 h; needs 3 h 15 a week; load 78% → 96%; finish 2026-11-29; 2 active projects";

describe("grounding", () => {
  it("reads numbers as written", () => {
    expect(numbersIn("3 h 15 · 96% · 1.5 · 2026-11-29")).toEqual([3, 15, 96, 1.5, 2026, 11, 29]);
  });

  it("passes text whose numbers are all in the facts", () => {
    expect(
      groundText(["Load goes from 78% to 96%.", "2 active projects already."], FACTS),
    ).toBeNull();
    expect(groundText(["Finish by 29 Nov."], FACTS)).toBeNull();
  });

  it("names numbers the model made up", () => {
    expect(ungroundedNumbers(["Load would hit 104%.", "About 20 hours."], FACTS)).toEqual([
      104, 20,
    ]);
    expect(groundText(["Load would hit 104%."], FACTS)).toBe("numbers not in the facts: 104");
  });

  it("reads thousands separators as one number", () => {
    expect(numbersIn("12,000 ETB and 1,200 min")).toEqual([12000, 1200]);
    expect(groundText(["about 1,200 min"], "1200 min")).toBeNull();
    expect(groundText(["200 h left"], "goal 1,200 min")).toBe("numbers not in the facts: 200");
  });

  it("checks numbers written as words", () => {
    expect(groundText(["This will take about forty hours."], "estimate 5 h")).toBe(
      "numbers not in the facts: 40",
    );
    expect(groundText(["Two projects already run."], FACTS)).toBeNull();
    expect(groundText(["Pick one thing."], FACTS)).toBeNull();
  });

  it("finds unknown ids", () => {
    expect(unknownIds(["p1", "p9"], ["p1", "p2"])).toEqual(["p9"]);
  });
});
