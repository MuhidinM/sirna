/**
 * The day-plan generator (plan §3.3). Pure: it gets everything it needs as
 * input and returns the day's blocks and top 3, so it is tested with fixture
 * weeks and never reads the clock or the database.
 *
 * 1. Copy the weekday's fixed and routine blocks (and keep blocks you edited).
 * 2. A light day (two low-energy nights, or the rest day) keeps only those,
 *    plus one top task.
 * 3. Area blocks go to the area furthest behind its weekly target (as a share),
 *    ties broken by priority. Capped areas stop at their target. An area with a
 *    task due within 48 hours goes first.
 * 4. Tasks go into their area's blocks: deadline first, then oldest. A task
 *    with no area never goes into an area block. A task with more estimated
 *    time left than one block continues in the next one (and on later days,
 *    since it stays open).
 * 5. At least 20% of free time stays unplanned.
 *
 * Time first (docs/proposals/time-first.md §1):
 * - A task with a time gets its own block at that time (its estimate long,
 *   else 30 min). It takes its time out of focus slots like a calendar event
 *   and may sit beside a fixed block.
 * - A task with a part of the day goes into the first free gap in that window.
 * - A task with no area and no time gets a neutral block in free time left
 *   after the area slots, when it has an estimate (the buffer still holds).
 * 6. Top 3: last night's choice, then deadlines within 48 h, then the most
 *    behind area's task.
 */

export interface AreaInput {
  id: string;
  name: string;
  weeklyTargetMin: number;
  capped: boolean;
  protected: boolean;
  priorityRank: number;
  active: boolean;
  kind: "work" | "growth" | "health" | "faith" | "admin";
}

export interface TemplateBlock {
  startMin: number;
  durationMin: number;
  kind: "fixed" | "routine" | "area" | "rest";
  areaId: string | null;
  title: string;
}

export interface TaskInput {
  id: string;
  title: string;
  areaId: string | null;
  dueDate: string | null;
  createdAt: number;
  /** Minutes left of its estimate; null when it has none (one block is enough). */
  remainingMin?: number | null;
  /** Its whole estimate: the length of its own block. */
  estimateMin?: number | null;
  /** Minute of this day (from local midnight) it is set for; null or absent when untimed. */
  atMin?: number | null;
  /** The part of this day it asked for. */
  window?: DayWindow | null;
  /**
   * A step of a split task: planned after the steps before it; `waits` while
   * one of them is still to do (then it is never in Top 3).
   */
  step?: { parentId: string; no: number; waits: boolean };
}

export type DayWindow = "morning" | "afternoon" | "evening";

/** Parts of the day, in minutes from local midnight (evening covers "tonight"). */
export const WINDOWS: Record<DayWindow, { startMin: number; endMin: number }> = {
  morning: { startMin: 6 * 60, endMin: 12 * 60 },
  afternoon: { startMin: 12 * 60, endMin: 17 * 60 },
  evening: { startMin: 17 * 60, endMin: 22 * 60 },
};

/** A timed task's block length when it has no estimate. */
export const TASK_BLOCK_MIN = 30;
/** The logical day ends at 03:00 the next morning, in minutes from local midnight. */
export const DAY_END_MIN = 27 * 60;
/** The shortest focus or task block worth planning. */
export const MIN_BLOCK_MIN = 25;

/** A block you edited or added; regeneration keeps it and plans around it. */
export interface KeptBlock {
  startMin: number;
  durationMin: number;
  /** The task it holds: a task block you moved isn't made again. */
  taskId?: string | null;
  /** Its title: a new block with the same title and start would clash with it. */
  title?: string;
  /**
   * Its kind: a kept routine or calendar block stands for the template block
   * or event of the same kind and title, wherever you moved it.
   */
  kind?: TemplateBlock["kind"];
  /** Its area: a timed task of that area inside it is listed there (rule 1). */
  areaId?: string | null;
}

export interface PlanInput {
  date: string; // logical date
  isRestDay: boolean;
  /** The last two evening energy ratings, newest first (1 = drained). */
  recentEnergy: number[];
  template: TemplateBlock[];
  kept: KeptBlock[];
  areas: AreaInput[];
  /** Minutes already spent per area this week, before today. */
  doneThisWeekMin: Record<string, number>;
  tasks: TaskInput[];
  /** Task ids chosen last night for today's top 3, in order. */
  chosenTop: string[];
  /** Timed events from your calendar: fixed, and never filled. */
  events?: CalendarEvent[];
  /** Window tasks are placed from this minute on (today: now). */
  notBeforeMin?: number;
  /** Tasks whose own block you deleted today: not made again. */
  removedTaskIds?: string[];
  /**
   * Other blocks you deleted today: a routine or calendar block of the same
   * name isn't copied again, and an area block's time stays empty.
   */
  removedBlocks?: RemovedBlock[];
}

export interface RemovedBlock {
  startMin: number;
  durationMin: number;
  kind: TemplateBlock["kind"];
  title: string;
}

export interface CalendarEvent {
  startMin: number;
  durationMin: number;
  title: string;
}

export interface PlannedBlock {
  startMin: number;
  durationMin: number;
  kind: TemplateBlock["kind"];
  areaId: string | null;
  taskId: string | null;
  title: string;
  /** A task's own block (timed, window or neutral), titled with the task. */
  fromTask?: boolean;
}

export interface DayPlan {
  light: boolean;
  blocks: PlannedBlock[];
  top: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const BUFFER_SHARE = 0.2;
/** Areas the planner fills free time with; others (jobs, gym, prayer) have their own blocks. */
export const FILLABLE_KINDS = new Set(["growth", "admin"]);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The parts of a slot not covered by any busy block. */
export function cut(
  slot: { startMin: number; durationMin: number },
  busy: { startMin: number; durationMin: number }[],
): { startMin: number; durationMin: number }[] {
  let pieces = [{ start: slot.startMin, end: slot.startMin + slot.durationMin }];
  for (const block of busy) {
    const from = block.startMin;
    const to = block.startMin + block.durationMin;
    pieces = pieces.flatMap((piece) =>
      to <= piece.start || from >= piece.end
        ? [piece]
        : [
            { start: piece.start, end: Math.max(piece.start, from) },
            { start: Math.min(piece.end, to), end: piece.end },
          ].filter((part) => part.end > part.start),
    );
  }
  return pieces.map((piece) => ({ startMin: piece.start, durationMin: piece.end - piece.start }));
}

function overlaps(
  a: { startMin: number; durationMin: number },
  b: { startMin: number; durationMin: number },
): boolean {
  return a.startMin < b.startMin + b.durationMin && b.startMin < a.startMin + a.durationMin;
}

const QUARTER = 15;

/**
 * The first start in [from, until) where `length` minutes fit between the busy
 * blocks, on a quarter hour. Null when nothing that long is free.
 */
export function firstGap(
  busy: { startMin: number; durationMin: number }[],
  length: number,
  from: number,
  until: number,
): number | null {
  let start = Math.ceil(from / QUARTER) * QUARTER;
  for (const block of [...busy].sort((a, b) => a.startMin - b.startMin)) {
    const end = block.startMin + block.durationMin;
    if (end <= start) continue;
    if (block.startMin - start >= length) break;
    start = Math.ceil(end / QUARTER) * QUARTER;
  }
  return start + length <= until ? start : null;
}

/** It has an estimate (and some of it is left). */
export function hasEstimate(task: TaskInput): boolean {
  return (task.remainingMin ?? task.estimateMin ?? 0) > 0;
}

/** Tasks due within 48 h (overdue included), soonest first. */
function urgent(tasks: TaskInput[], date: string): TaskInput[] {
  return tasks
    .filter((task) => task.dueDate !== null && daysBetween(date, task.dueDate) <= 2)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.createdAt - b.createdAt);
}

function byDeadlineThenAge(a: TaskInput, b: TaskInput): number {
  // Steps of one task keep their order.
  if (a.step && b.step && a.step.parentId === b.step.parentId) return a.step.no - b.step.no;
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return a.createdAt - b.createdAt;
}

/**
 * The template blocks and events a kept block stands for: one each, of the
 * same kind and title, the nearest in time (the same start first). A routine
 * or calendar block you moved isn't copied again at its old time.
 */
function keptStandIns(
  kept: KeptBlock[],
  template: TemplateBlock[],
  events: CalendarEvent[],
): Set<object> {
  const candidates = [
    ...template
      .filter((block) => block.kind !== "area")
      .map((block) => ({ source: block as object, kind: block.kind, ...pick(block) })),
    ...events.map((event) => ({ source: event as object, kind: "fixed" as const, ...pick(event) })),
  ];
  const taken = new Set<object>();
  const named = kept.filter((block) => block.kind && block.kind !== "area" && block.title);
  // Blocks still at their own time pair first, so a moved twin takes the other one.
  const ordered = [
    ...named.filter((block) =>
      candidates.some((c) => same(c, block) && c.startMin === block.startMin),
    ),
    ...named.filter(
      (block) => !candidates.some((c) => same(c, block) && c.startMin === block.startMin),
    ),
  ];
  for (const block of ordered) {
    const twin = candidates
      .filter((c) => !taken.has(c.source) && same(c, block))
      .sort(
        (a, b) => Math.abs(a.startMin - block.startMin) - Math.abs(b.startMin - block.startMin),
      )[0];
    if (twin) taken.add(twin.source);
  }
  return taken;
}

function pick(block: { title: string; startMin: number }) {
  return { title: block.title, startMin: block.startMin };
}

function same(candidate: { kind: string; title: string }, kept: KeptBlock): boolean {
  return candidate.kind === kept.kind && candidate.title === kept.title;
}

export function generateDay(input: PlanInput): DayPlan {
  const light =
    input.isRestDay ||
    (input.recentEnergy.length >= 2 && input.recentEnergy.slice(0, 2).every((e) => e <= 1));
  const free = (block: { startMin: number; durationMin: number }) =>
    !input.kept.some((kept) => overlaps(kept, block));
  const removed = input.removedBlocks ?? [];
  /** A routine or calendar block you deleted today (same name, same time) isn't copied again. */
  const notRemoved = (block: { title: string; startMin: number; durationMin: number }) =>
    !removed.some(
      (gone) => gone.kind !== "area" && gone.title === block.title && overlaps(gone, block),
    );
  /** Area blocks you deleted today: their time stays empty. */
  const removedAreaTime = removed.filter((gone) => gone.kind === "area");

  const events = (input.events ?? []).filter((event) => event.durationMin > 0);
  const standIns = keptStandIns(input.kept, input.template, events);
  const notMoved = (block: object) => !standIns.has(block);

  // 1. Fixed and routine blocks (and the rest block) from the template.
  const blocks: PlannedBlock[] = input.template
    .filter((block) => block.kind !== "area")
    .filter(free)
    .filter(notRemoved)
    .filter(notMoved)
    .map((block) => ({ ...block, taskId: null }));
  // Calendar events are fixed blocks; a block you edited still wins.
  const shownEvents = events.filter(notRemoved).filter(notMoved);
  for (const event of shownEvents.filter(free))
    blocks.push({ ...event, kind: "fixed", areaId: null, taskId: null });

  const activeAreas = input.areas.filter((area) => area.active);
  const keptTasks = new Set([
    ...input.kept.flatMap((kept) => (kept.taskId ? [kept.taskId] : [])),
    ...(input.removedTaskIds ?? []),
  ]);
  const tasksLeft = input.tasks.filter((task) => !keptTasks.has(task.id));
  const planned: Record<string, number> = {};
  /** Time tasks took for themselves: it comes out of the focus slots. */
  const taken: { startMin: number; durationMin: number }[] = [];
  const addTaskBlock = (task: TaskInput, startMin: number, durationMin: number) => {
    // The same title at the same minute is already there (the database allows one).
    if (blocks.some((b) => b.startMin === startMin && b.title === task.title)) return;
    blocks.push({
      startMin,
      durationMin,
      kind: "area",
      areaId: task.areaId,
      taskId: task.id,
      title: task.title,
      fromTask: true,
    });
    taken.push({ startMin, durationMin });
    if (task.areaId) planned[task.areaId] = (planned[task.areaId] ?? 0) + durationMin;
  };
  const drop = (task: TaskInput) => {
    const index = tasksLeft.indexOf(task);
    if (index >= 0) tasksLeft.splice(index, 1);
  };
  const lengthOf = (task: TaskInput) =>
    task.estimateMin && task.estimateMin > 0 ? task.estimateMin : TASK_BLOCK_MIN;

  /**
   * A block of the task's own area (Job A, a routine) that already covers
   * its time: the task is listed inside that block, not given a card beside it.
   */
  const hostOf = (task: TaskInput, startMin: number, durationMin: number) =>
    task.areaId === null
      ? undefined
      : [...blocks, ...input.kept.filter((kept) => !kept.taskId)].find(
          (block) =>
            block.areaId === task.areaId &&
            block.kind !== "rest" &&
            block.startMin <= startMin &&
            startMin + durationMin <= block.startMin + block.durationMin,
        );

  // Time first, rule 1: a task with a time gets its own block at that time.
  for (const task of tasksLeft.filter((t) => t.atMin !== null && t.atMin !== undefined)) {
    const startMin = task.atMin ?? 0;
    // A block never runs past the end of its logical day (03:00 next morning).
    const length = Math.max(1, Math.min(lengthOf(task), DAY_END_MIN - startMin));
    if (!hostOf(task, startMin, length)) addTaskBlock(task, startMin, length);
    drop(task);
  }
  // Rule 2: a task with a part of the day goes into the first free gap in it.
  for (const task of tasksLeft.filter((t) => t.window).sort(byDeadlineThenAge)) {
    const window = WINDOWS[task.window ?? "morning"];
    const length = lengthOf(task);
    const from = Math.max(window.startMin, input.notBeforeMin ?? 0);
    const start = firstGap([...blocks, ...input.kept], length, from, window.endMin);
    if (start === null) continue; // no room: it stays an ordinary task
    addTaskBlock(task, start, length);
    drop(task);
  }

  const left = new Map<string, number>();
  const charge = (task: TaskInput, minutes: number) => {
    const remaining = (left.get(task.id) ?? task.remainingMin ?? 0) - minutes;
    // Done for today once its estimate is covered (or it had none).
    if (remaining > 0) left.set(task.id, remaining);
    else drop(task);
  };
  /** Rule 4: an area's slot holds only that area's tasks. */
  const takeTask = (areaId: string, minutes: number): TaskInput | undefined => {
    const task = tasksLeft.filter((t) => t.areaId === areaId).sort(byDeadlineThenAge)[0];
    if (task) charge(task, minutes);
    return task;
  };

  if (!light) {
    // 5. Free time = waking time not taken by fixed/routine blocks; keep 20% of it open.
    // Time off (a short Rest block) is busy: no slot overlapping it is filled.
    const off = input.template.filter((block) => block.kind === "rest");
    const areaSlots = input.template
      .filter((block) => block.kind === "area")
      .filter(free)
      .filter((slot) => !off.some((rest) => overlaps(rest, slot)))
      // An event or a task's own block takes its time out of a slot; the rest still gets filled.
      .flatMap((slot) =>
        cut(slot, [...events, ...taken, ...removedAreaTime]).map((piece) => ({
          ...slot,
          ...piece,
        })),
      )
      .filter((slot) => slot.durationMin >= MIN_BLOCK_MIN)
      // Slots you tied to an area come first, so the buffer never squeezes them out.
      .sort(
        (a, b) => Number(b.areaId !== null) - Number(a.areaId !== null) || a.startMin - b.startMin,
      );
    const freeMin = areaSlots.reduce((sum, block) => sum + block.durationMin, 0);
    const budget = Math.floor(freeMin * (1 - BUFFER_SHARE));
    /** What is left of each slot after the area blocks. */
    const leftover: { startMin: number; durationMin: number }[] = [];

    // 3. Fill each slot with the area furthest behind.
    const urgentAreas = [
      ...new Set(urgent(input.tasks, input.date).map((task) => task.areaId)),
    ].filter((id): id is string => id !== null);
    let used = 0;
    for (const slot of areaSlots) {
      const duration = Math.min(slot.durationMin, budget - used);
      if (duration < MIN_BLOCK_MIN) {
        leftover.push(slot);
        continue;
      }
      const fillable = activeAreas.filter(
        (area) => FILLABLE_KINDS.has(area.kind) && area.weeklyTargetMin > 0,
      );
      const remaining = (area: AreaInput) =>
        area.weeklyTargetMin - (input.doneThisWeekMin[area.id] ?? 0) - (planned[area.id] ?? 0);
      const eligible = fillable.filter((area) => !area.capped || remaining(area) > 0);
      // A free slot you tied to an area in My week gets that area.
      const tied = slot.areaId ? activeAreas.find((area) => area.id === slot.areaId) : undefined;
      const urgentPick = urgentAreas.find(
        (id) => eligible.some((area) => area.id === id) && !(planned[id] ?? 0),
      );
      const pick =
        tied ??
        eligible.find((area) => area.id === urgentPick) ??
        [...eligible].sort(
          (a, b) =>
            remaining(b) / b.weeklyTargetMin - remaining(a) / a.weeklyTargetMin ||
            a.priorityRank - b.priorityRank,
        )[0];
      // A deadline beats the weekly target: an urgent area gets its block even
      // when its target is met (a capped area still stops at its cap).
      const isUrgent = pick !== undefined && pick.id === urgentPick;
      const minutes = pick?.capped ? Math.min(duration, remaining(pick)) : duration;
      if (
        !pick ||
        (!tied && !isUrgent && remaining(pick) <= 0) ||
        (tied?.capped && remaining(tied) <= 0) ||
        minutes < MIN_BLOCK_MIN
      ) {
        leftover.push(slot);
        continue;
      }
      planned[pick.id] = (planned[pick.id] ?? 0) + minutes;
      used += minutes;
      // 4. The area's most pressing task goes into the block.
      const task = takeTask(pick.id, minutes);
      blocks.push({
        startMin: slot.startMin,
        durationMin: minutes,
        kind: "area",
        areaId: pick.id,
        taskId: task?.id ?? null,
        title: task ? `${pick.name}: ${task.title}` : pick.name,
      });
      if (slot.durationMin - minutes >= MIN_BLOCK_MIN)
        leftover.push({
          startMin: slot.startMin + minutes,
          durationMin: slot.durationMin - minutes,
        });
    }

    // Rule 5: a task with no area and no time, with an estimate, gets a
    // neutral block in the free time left, inside the buffer.
    leftover.sort((a, b) => a.startMin - b.startMin);
    const loose = tasksLeft
      .filter((task) => task.areaId === null && hasEstimate(task))
      .sort(byDeadlineThenAge);
    /** Where the latest planned step of each split task ends: the next step starts after it. */
    const stepEnds = new Map<string, number>();
    for (const block of blocks) {
      const step = input.tasks.find((t) => t.id === block.taskId)?.step;
      if (step)
        stepEnds.set(
          step.parentId,
          Math.max(stepEnds.get(step.parentId) ?? 0, block.startMin + block.durationMin),
        );
    }
    for (const task of loose) {
      for (let i = 0; i < leftover.length && tasksLeft.includes(task); i++) {
        const piece = leftover[i];
        if (!piece) continue;
        const after = task.step ? (stepEnds.get(task.step.parentId) ?? 0) : 0;
        if (piece.startMin < after) continue;
        const need = left.get(task.id) ?? task.remainingMin ?? task.estimateMin ?? 0;
        const minutes = Math.min(need, piece.durationMin, budget - used);
        // A short task (a 15-minute step) gets a block of its own length.
        if (minutes < Math.min(MIN_BLOCK_MIN, need)) continue;
        addTaskBlock(task, piece.startMin, minutes);
        if (task.step) stepEnds.set(task.step.parentId, Math.max(after, piece.startMin + minutes));
        used += minutes;
        charge(task, minutes);
        leftover[i] = {
          startMin: piece.startMin + minutes,
          durationMin: piece.durationMin - minutes,
        };
      }
    }
  }

  blocks.sort((a, b) => a.startMin - b.startMin);

  // 6. Top 3.
  const top: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !top.includes(id) && top.length < (light ? 1 : 3)) top.push(id);
  };
  // A later step whose earlier step is still to do never takes a Top 3 place.
  const waiting = new Set(input.tasks.filter((task) => task.step?.waits).map((task) => task.id));
  const known = new Set(input.tasks.filter((task) => !waiting.has(task.id)).map((task) => task.id));
  input.chosenTop.filter((id) => known.has(id)).forEach(add);
  urgent(input.tasks, input.date)
    .filter((task) => known.has(task.id))
    .forEach((task) => add(task.id));
  blocks
    .filter((block) => block.kind === "area" && !waiting.has(block.taskId ?? ""))
    .forEach((block) => add(block.taskId));

  // A block you kept with the same title at the same minute stands in for a
  // new one (the database allows one per day, title and start).
  const keptAlready = (block: { startMin: number; title: string }) =>
    input.kept.some((kept) => kept.title === block.title && kept.startMin === block.startMin);
  return { light, blocks: blocks.filter((block) => !keptAlready(block)), top };
}
