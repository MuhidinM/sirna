/**
 * Builds the starting weekly routine from the setup answers (plan §3.1–3.2).
 * Pure: the same answers always give the same blocks, and it is tested.
 */

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // Monday = 1 … Sunday = 7

export interface TimeRange {
  start: string; // "08:00"
  end: string; // "12:00"
}

/** A job day has 1 to 3 parts; the gaps between them (lunch) are not job time. */
export const MAX_JOB_PARTS = 3;

export interface JobAnswer {
  /** Any work area: Job A, Job B, a third job… */
  areaId: string;
  name: string;
  days: Weekday[];
  parts: TimeRange[];
  /** @deprecated Saves before job parts had one range; read them with `jobParts`. */
  start?: string;
  /** @deprecated See `start`. */
  end?: string;
}

/** A job as it may be saved: answers from before job parts have no `parts`. */
export type SavedJob = Omit<JobAnswer, "parts"> & { parts?: TimeRange[] };

/** The job's parts; an old save's single start and end is one part. */
export function jobParts(job: SavedJob): TimeRange[] {
  return job.parts ?? [{ start: job.start ?? "", end: job.end ?? "" }];
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
  /** A 1-hour lunch on workdays, kept free of focus blocks; none when missing or "". */
  lunch?: string; // "12:00"
}

export const LUNCH_MIN = 60;

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
    {
      areaId: "joba",
      name: "Job A",
      days: [1, 2, 3, 4, 5],
      parts: [{ start: "08:00", end: "12:00" }],
    },
    {
      areaId: "jobb",
      name: "Job B",
      days: [1, 2, 3, 4, 5],
      parts: [{ start: "13:00", end: "17:00" }],
    },
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

export type FixedRow = {
  weekday: number;
  start_min: number;
  duration_min: number;
};

/**
 * A job made in My week, read back as a setup answer from its fixed routine
 * blocks: the days it has a block, and the parts of its first day (up to 3).
 * With no blocks it has no days yet.
 */
export function jobFromBlocks(areaId: string, name: string, rows: FixedRow[]): JobAnswer {
  const sorted = [...rows].sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min);
  const days = [...new Set(sorted.map((row) => row.weekday))].filter(
    (day): day is Weekday => day >= 1 && day <= 7,
  );
  const firstDay = sorted.filter((row) => row.weekday === sorted[0]?.weekday);
  const parts = firstDay.slice(0, MAX_JOB_PARTS).map((row) => ({
    start: toHhmm(row.start_min),
    end: toHhmm(Math.min(row.start_min + row.duration_min, 1439)),
  }));
  return {
    areaId,
    name,
    days,
    parts: parts.length > 0 ? parts : [{ start: "09:00", end: "17:00" }],
  };
}

/**
 * True when `jobFromBlocks` can't keep these blocks as they are: the days have
 * different hours, or a day has more than 3 blocks. Saving setup then uses the
 * first day's hours for every day.
 */
export function blockHoursDiffer(rows: FixedRow[]): boolean {
  const byDay = new Map<number, string[]>();
  for (const row of [...rows].sort((a, b) => a.start_min - b.start_min)) {
    byDay.set(row.weekday, [
      ...(byDay.get(row.weekday) ?? []),
      `${row.start_min}+${row.duration_min}`,
    ]);
  }
  const days = [...byDay.values()].map((hours) => hours.join(","));
  return (
    [...byDay.values()].some((hours) => hours.length > MAX_JOB_PARTS) ||
    days.some((hours) => hours !== days[0])
  );
}

/**
 * Work areas made in My week that setup does not know yet, as jobs. Only
 * areas with fixed blocks join: one with no set hours has nothing to rebuild,
 * so setup leaves it alone.
 */
export function jobsFromMyWeek(
  areas: { id: string; name: string; kind: string; active: number }[],
  rows: (FixedRow & { area_id: string })[],
  knownIds: Iterable<string>,
): (JobAnswer & { hoursDiffer: boolean })[] {
  const known = new Set(knownIds);
  return areas
    .filter((area) => area.kind === "work" && area.active === 1 && !known.has(area.id))
    .map((area) => ({ area, blocks: rows.filter((row) => row.area_id === area.id) }))
    .filter(({ blocks }) => blocks.length > 0)
    .map(({ area, blocks }) => ({
      ...jobFromBlocks(area.id, area.name, blocks),
      hoursDiffer: blockHoursDiffer(blocks),
    }));
}

/**
 * The part "+ Part" adds: it starts an hour after the last part ends (after
 * lunch) and runs 2 hours, up to 23:59. Null when there is no room: 3 parts
 * already, or the last part ends after 21:00.
 */
export function nextPart(parts: TimeRange[]): TimeRange | null {
  if (parts.length >= MAX_JOB_PARTS) return null;
  // An unfinished time: start from noon.
  const lastEnd = minutesOf(parts.at(-1)?.end) ?? 12 * 60;
  const from = lastEnd + 60;
  if (from > 22 * 60) return null;
  return { start: toHhmm(from), end: toHhmm(Math.min(from + 120, 23 * 60 + 59)) };
}

/** Minutes of a time, or null when it is not one ("" included). */
function minutesOf(hhmm: string | undefined): number | null {
  try {
    return toMinutes(hhmm ?? "");
  } catch {
    return null;
  }
}

/**
 * What stops the jobs from being saved, in words; null when they are fine.
 * Names must be filled in and differ; a job that is on needs a day and 1 to
 * 3 parts that end after they start and don't overlap, within the job or
 * with another job on the same day. Lunch must not sit inside job hours.
 * `enabled: false` marks a job that is ticked off.
 */
export function jobProblems(
  jobs: (JobAnswer & { enabled?: boolean })[],
  lunch?: string,
): string | null {
  const seen = new Set<string>();
  for (const job of jobs) {
    const name = job.name.trim();
    if (!name) return "Every job needs a name.";
    if (seen.has(name.toLowerCase()))
      return `Two jobs are called "${name}". Give each its own name.`;
    seen.add(name.toLowerCase());
  }
  for (const job of jobs) {
    if (job.enabled === false) continue;
    if (job.days.length === 0) return `${job.name.trim()}: pick its days, or untick it.`;
  }

  const ranges: { name: string; days: Weekday[]; from: number; to: number }[] = [];
  for (const job of jobs) {
    if (job.enabled === false) continue;
    const name = job.name.trim();
    if (job.parts.length === 0) return `${name}: give it its hours.`;
    if (job.parts.length > MAX_JOB_PARTS) return `${name}: at most ${MAX_JOB_PARTS} parts a day.`;
    for (const part of job.parts) {
      const from = minutesOf(part.start);
      const to = minutesOf(part.end);
      if (from === null || to === null) return `${name}: fill in each From and To time.`;
      if (to <= from)
        return `${name}: ${part.start}–${part.end} must end after it starts, on the same day.`;
      ranges.push({ name, days: job.days, from, to });
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      if (!a || !b || !a.days.some((day) => b.days.includes(day))) continue;
      if (a.from < b.to && b.from < a.to)
        return a.name === b.name
          ? `${a.name}: two parts overlap.`
          : `${a.name} and ${b.name} overlap on the same day.`;
    }
  }

  if (lunch) {
    const from = minutesOf(lunch);
    if (from === null) return "Lunch: use a time like 12:00, or leave it empty.";
    if (from + LUNCH_MIN > 24 * 60) return "Lunch must end by midnight.";
    const inside = ranges.find((range) => from < range.to && range.from < from + LUNCH_MIN);
    if (inside)
      return `Lunch overlaps ${inside.name}. Leave lunch out of job hours: end a part before it.`;
  }
  return null;
}

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
      // One fixed block per part, all with the job's name (setup checks the parts).
      for (const part of jobParts(job)) {
        const start = toMinutes(part.start);
        const end = toMinutes(part.end);
        if (end > start)
          add({
            startMin: start,
            durationMin: end - start,
            kind: "fixed",
            areaId: job.areaId,
            title: job.name,
          });
      }
    }

    // Lunch keeps the gap between job parts out of the focus-block filler.
    if (isWorkday && answers.lunch)
      add({
        startMin: toMinutes(answers.lunch),
        durationMin: LUNCH_MIN,
        kind: "routine",
        areaId: null,
        title: "Lunch",
      });

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
      // gaps; one at a free time does, so no focus block lands on it. Touching
      // a longer block counts as inside only where that block's edge gets the
      // 15-minute buffer (a check at 10:00 after a part ending at 10:00); at
      // the window's edges there is no buffer, so the check splits the gap.
      const inside = (block: BlockDraft) => {
        const end = block.startMin + block.durationMin;
        return today.some((other) => {
          const otherEnd = other.startMin + other.durationMin;
          if (other === block || other.durationMin <= block.durationMin) return false;
          if (other.startMin <= block.startMin && end <= otherEnd) return true;
          if (otherEnd === block.startMin) return otherEnd > from;
          if (end === other.startMin) return other.startMin < limit;
          return false;
        });
      };
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
