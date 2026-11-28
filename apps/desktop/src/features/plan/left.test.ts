import { describe, expect, it } from "vitest";

import { leftFloor, MIN_LEFT_MIN, timeLeft } from "./left";

describe("time left on an open task (T-082)", () => {
  it("floors at MIN_LEFT_MIN, or the whole estimate when shorter", () => {
    expect(leftFloor({ estimateMin: 60 })).toBe(MIN_LEFT_MIN);
    expect(leftFloor({ estimateMin: MIN_LEFT_MIN })).toBe(MIN_LEFT_MIN);
    expect(leftFloor({ estimateMin: 5 })).toBe(5);
    expect(leftFloor({ estimateMin: 0 })).toBe(0);
    expect(leftFloor({ estimateMin: null })).toBe(0);
  });

  it("never reads 0 for an estimated task that ran over", () => {
    expect(timeLeft({ remainingMin: 0, estimateMin: 60 })).toBe(MIN_LEFT_MIN);
    expect(timeLeft({ remainingMin: MIN_LEFT_MIN - 1, estimateMin: 60 })).toBe(MIN_LEFT_MIN);
    expect(timeLeft({ remainingMin: MIN_LEFT_MIN + 1, estimateMin: 60 })).toBe(MIN_LEFT_MIN + 1);
    expect(timeLeft({ remainingMin: 0, estimateMin: 5 })).toBe(5);
  });

  it("keeps no estimate as no estimate", () => {
    expect(timeLeft({ remainingMin: null, estimateMin: null })).toBeNull();
    expect(timeLeft({ remainingMin: 0, estimateMin: 0 })).toBe(0);
  });
});
