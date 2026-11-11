/**
 * The only place product code may read the current time (docs/testing.md).
 * Everything else takes a Clock so tests can set and move time.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch (UTC). */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface FakeClock extends Clock {
  set(epochMs: number): void;
  advance(ms: number): void;
}

export function createFakeClock(startEpochMs: number): FakeClock {
  let current = startEpochMs;
  return {
    now: () => current,
    set: (epochMs) => {
      current = epochMs;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
