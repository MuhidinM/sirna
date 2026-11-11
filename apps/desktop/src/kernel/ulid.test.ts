import { describe, expect, it } from "vitest";

import { createFakeClock } from "./clock";
import { isUlid, ulid, ulidTime } from "./ulid";

const zeros = (length: number) => new Uint8Array(length);
const ones = (length: number) => new Uint8Array(length).fill(255);

describe("ulid", () => {
  it("is 26 Crockford base32 characters", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it("encodes the clock's time in the first 10 characters", () => {
    const clock = createFakeClock(Date.parse("2026-11-11T08:00:00Z"));
    const id = ulid(clock, zeros);
    expect(ulidTime(id)).toBe(clock.now());
    expect(id.slice(10)).toBe("0000000000000000");
  });

  it("uses all 80 random bits", () => {
    const id = ulid(createFakeClock(0), ones);
    expect(id).toBe("0000000000ZZZZZZZZZZZZZZZZ");
  });

  it("sorts by creation time", () => {
    const clock = createFakeClock(Date.parse("2026-11-11T08:00:00Z"));
    const first = ulid(clock, ones);
    clock.advance(1);
    const second = ulid(clock, zeros);
    expect([second, first].sort()).toEqual([first, second]);
  });

  it("gives different ids at the same millisecond", () => {
    const clock = createFakeClock(1_000);
    expect(ulid(clock)).not.toBe(ulid(clock));
  });

  it("rejects times outside 48 bits", () => {
    expect(() => ulid(createFakeClock(-1))).toThrow(RangeError);
    expect(() => ulid(createFakeClock(2 ** 48))).toThrow(RangeError);
  });

  it("recognises invalid ids", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false); // I is not Crockford
    expect(isUlid("81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false); // over 48 bits
    expect(isUlid("short")).toBe(false);
  });
});
