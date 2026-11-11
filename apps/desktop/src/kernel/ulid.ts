/**
 * ULIDs for user rows (plan §5.1): 48-bit millisecond time + 80 random bits,
 * Crockford base32, 26 characters. They sort by creation time and need no
 * coordination, so a later sync keeps the same keys.
 */
import { type Clock, systemClock } from "./clock";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;

export type RandomBytes = (length: number) => Uint8Array;

const cryptoRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

function encodeTime(epochMs: number): string {
  if (!Number.isInteger(epochMs) || epochMs < 0 || epochMs > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${epochMs}`);
  }
  let out = "";
  let rest = epochMs;
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = (ENCODING[rest % 32] ?? "0") + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 characters × 5 bits = 80 bits = 10 bytes.
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING[(value >> bits) & 31] ?? "0";
    }
  }
  return out.slice(0, RANDOM_LENGTH);
}

export function ulid(clock: Clock = systemClock, random: RandomBytes = cryptoRandom): string {
  return encodeTime(clock.now()) + encodeRandom(random(10));
}

/** The creation time encoded in a ULID, in epoch milliseconds. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, TIME_LENGTH)) {
    const index = ENCODING.indexOf(char);
    if (index < 0) throw new RangeError(`Not a ULID: ${id}`);
    time = time * 32 + index;
  }
  return time;
}

export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
