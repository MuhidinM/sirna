/**
 * Builds the starting weekly routine from the setup answers (plan §3.1–3.2).
 * Pure: the same answers always give the same blocks, and it is tested.
 */

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // Monday = 1 … Sunday = 7

export interface JobAnswer {
  areaId: "joba" | "jobb";
  name: string;
  days: Weekday[];
  start: string; // "08:00"
  end: string; // "12:00"
}

export interface SetupAnswers {
  wake: string; // "06:00"
  hardStop: string; // "22:30"
  review: string; // "21:00"
  jobs: JobAnswer[];
  activeAreas: string[]; // area ids the user keeps
  restDay: Weekday;
  gymDays: Weekday[];
  gymTime: string; // "17:30"
  /** 10-minute "Check email" reminders on workdays; empty for none. */
  emailChecks: string[]; // ["10:00", "15:00"]
}

export interface BlockDraft {
  weekday: Weekday;
  startMin: number;
  durationMin: number;
  kind: "fixed" | "routine" | "area" | "rest";
  areaId: string | null;
  title: string;
}

export const DEFAULT_ANSWERS: SetupAnswers = {
  wake: "06:00",
  hardStop: "22:30",
  review: "21:00",
  jobs: [
    { areaId: "joba", name: "Job A", days: [1, 2, 3, 4, 5], start: "08:00", end: "12:00" },
    { areaId: "jobb", name: "Job B", days: [1, 2, 3, 4, 5], start: "13:00", end: "17:00" },
  ],
  activeAreas: ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
  restDay: 7,
  gymDays: [1, 3, 5],
  gymTime: "17:30",
  emailChecks: ["10:00", "15:00"],
};

export function toMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new RangeError(`Not a time: ${hhmm}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 23 || Number(match[2]) > 59) throw new RangeError(`Not a time: ${hhmm}`);
  return minutes;
}

export function toHhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Reads "10:00, 15:30" into sorted unique times; "" is no times. Null when
 * any part is not a time.
 */
export function parseTimes(text: string): string[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const minutes: number[] = [];
  for (const part of parts) {
    try {
      minutes.push(toMinutes(part));
    } catch {
      return null;
    }
  }
  return [...new Set(minutes)].sort((a, b) => a - b).map(toHhmm);
}

const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Free gaps of a day, given the blocks already placed and the waking window. */
function gaps(blocks: BlockDraft[], from: number, to: number): [number, number][] {
  const busy = blocks
    .map((block) => [block.startMin, block.startMin + block.durationMin] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const free: [number, number][] = [];
  let cursor = from;
  for (const [start, end] of busy) {
    if (start > cursor) free.push([cursor, Math.min(start, to)]);
    cursor = Math.max(cursor, end);
    if (cursor >= to) break;
  }
  if (cursor < to) free.push([cursor, to]);
  return free.filter(([start, end]) => end - start > 0);
}

/**
 * The starting routine: jobs as fixed blocks, Quran after waking, gym on its
 * days, two email checks on workdays, the night review, a rest day, and
 * "area" blocks for the generator to fill. Nothing overlaps except
 * 10-minute email checks set inside another block (work hours by default);
 * the day ends at the hard stop.
 */
export function defaultRoutine(answers: SetupAnswers): BlockDraft[] {
  const wake = toMinutes(answers.wake);
  const stop = toMinutes(answers.hardStop);
  const review = toMinutes(answers.review);
  const active = new Set(answers.activeAreas);
  const blocks: BlockDraft[] = [];

  for (const day of ALL_DAYS) {
    const today: BlockDraft[] = [];
    const add = (block: Omit<BlockDraft, "weekday">) => today.push({ weekday: day, ...block });
    const isRestDay = day === answers.restDay;
    const isWorkday = answers.jobs.some((job) => active.has(job.areaId) && job.days.includes(day));

    if (active.has("quran"))
      add({ startMin: wake, durationMin: 20, kind: "routine", areaId: "quran", title: "Quran" });

    for (const job of answers.jobs) {
      if (!active.has(job.areaId) || !job.days.includes(day)) continue;
      const start = toMinutes(job.start);
      const end = toMinutes(job.end);
      if (end > start)
        add({
          startMin: start,
          durationMin: end - start,
          kind: "fixed",
          areaId: job.areaId,
          title: job.name,
        });
    }

    if (isWorkday && active.has("admin")) {
      // Older saved answers have no list: they keep the two default checks.
      for (const time of answers.emailChecks ?? DEFAULT_ANSWERS.emailChecks)
        add({
          startMin: toMinutes(time),
          durationMin: 10,
          kind: "routine",
          areaId: "admin",
          title: "Check email",
        });
    }

    if (active.has("gym") && answers.gymDays.includes(day) && !isRestDay) {
      add({
        startMin: toMinutes(answers.gymTime),
        durationMin: 45,
        kind: "routine",
        areaId: "gym",
        title: "Gym",
      });
    }

    add({
      startMin: review,
      durationMin: 15,
      kind: "routine",
      areaId: null,
      title: "Night review",
    });

    if (isRestDay) {
      add({
        startMin: wake + 30,
        durationMin: Math.max(30, review - wake - 60),
        kind: "rest",
        areaId: null,
        title: "Rest day",
      });
    } else {
      // Area blocks in free gaps: a 15-minute buffer on both sides, 45–90
      // minutes long, at most 2 on a workday and 3 on a free day (plan §3.7).
      const from = wake + 30;
      const limit = Math.min(review, stop);
      const maxBlocks = isWorkday ? 2 : 3;
      let placed = 0;
      // A short routine (an email check) inside a longer block doesn't split
      // gaps; one at a free time does, so no focus block lands on it.
      const inside = (block: BlockDraft) =>
        today.some(
          (other) =>
            other !== block &&
            other.durationMin > block.durationMin &&
            other.startMin <= block.startMin &&
            block.startMin + block.durationMin <= other.startMin + other.durationMin,
        );
      const anchors = today.filter((block) => block.durationMin > 15 || !inside(block));
      for (const [start, end] of gaps(anchors, from, limit)) {
        let cursor = start === from ? start : start + 15;
        const lastEnd = end === limit ? end : end - 15;
        while (placed < maxBlocks && lastEnd - cursor >= 45) {
          const duration = Math.min(90, lastEnd - cursor);
          add({
            startMin: cursor,
            durationMin: duration,
            kind: "area",
            areaId: null,
            title: "Focus block",
          });
          placed++;
          cursor += duration + 15;
        }
      }
    }

    blocks.push(...today.sort((a, b) => a.startMin - b.startMin));
  }
  return blocks;
}
