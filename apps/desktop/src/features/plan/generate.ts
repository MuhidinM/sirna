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
 * 4. Tasks go into their area's blocks: deadline first, then oldest.
 * 5. At least 20% of free time stays unplanned.
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
}

/** A block you edited or added; regeneration keeps it and plans around it. */
export interface KeptBlock {
  startMin: number;
  durationMin: number;
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
}

export interface PlannedBlock {
  startMin: number;
  durationMin: number;
  kind: TemplateBlock["kind"];
  areaId: string | null;
  taskId: string | null;
  title: string;
}

export interface DayPlan {
  light: boolean;
  blocks: PlannedBlock[];
  top: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const BUFFER_SHARE = 0.2;
const FILLABLE_KINDS = new Set(["growth", "admin"]);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function overlaps(
  a: { startMin: number; durationMin: number },
  b: { startMin: number; durationMin: number },
): boolean {
  return a.startMin < b.startMin + b.durationMin && b.startMin < a.startMin + a.durationMin;
}

/** Tasks due within 48 h (overdue included), soonest first. */
function urgent(tasks: TaskInput[], date: string): TaskInput[] {
  return tasks
    .filter((task) => task.dueDate !== null && daysBetween(date, task.dueDate) <= 2)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.createdAt - b.createdAt);
}

function byDeadlineThenAge(a: TaskInput, b: TaskInput): number {
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return a.createdAt - b.createdAt;
}

export function generateDay(input: PlanInput): DayPlan {
  const light =
    input.isRestDay ||
    (input.recentEnergy.length >= 2 && input.recentEnergy.slice(0, 2).every((e) => e <= 1));
  const free = (block: { startMin: number; durationMin: number }) =>
    !input.kept.some((kept) => overlaps(kept, block));

  // 1. Fixed and routine blocks (and the rest block) from the template.
  const blocks: PlannedBlock[] = input.template
    .filter((block) => block.kind !== "area")
    .filter(free)
    .map((block) => ({ ...block, taskId: null }));

  const activeAreas = input.areas.filter((area) => area.active);
  const tasksLeft = [...input.tasks];
  const takeTask = (areaId: string): TaskInput | undefined => {
    const candidates = tasksLeft.filter((task) => task.areaId === areaId).sort(byDeadlineThenAge);
    const task = candidates[0];
    if (task) tasksLeft.splice(tasksLeft.indexOf(task), 1);
    return task;
  };

  if (!light) {
    // 5. Free time = waking time not taken by fixed/routine blocks; keep 20% of it open.
    const areaSlots = input.template.filter((block) => block.kind === "area").filter(free);
    const freeMin = areaSlots.reduce((sum, block) => sum + block.durationMin, 0);
    const budget = Math.floor(freeMin * (1 - BUFFER_SHARE));

    // 3. Fill each slot with the area furthest behind.
    const planned: Record<string, number> = {};
    const urgentAreas = [
      ...new Set(urgent(input.tasks, input.date).map((task) => task.areaId)),
    ].filter((id): id is string => id !== null);
    let used = 0;
    for (const slot of areaSlots) {
      if (used >= budget) break;
      const duration = Math.min(slot.durationMin, budget - used);
      if (duration < 25) break;
      const fillable = activeAreas.filter(
        (area) => FILLABLE_KINDS.has(area.kind) && area.weeklyTargetMin > 0,
      );
      const remaining = (area: AreaInput) =>
        area.weeklyTargetMin - (input.doneThisWeekMin[area.id] ?? 0) - (planned[area.id] ?? 0);
      const eligible = fillable.filter((area) => !area.capped || remaining(area) > 0);
      const urgentPick = urgentAreas.find(
        (id) => eligible.some((area) => area.id === id) && !(planned[id] ?? 0),
      );
      const pick =
        eligible.find((area) => area.id === urgentPick) ??
        [...eligible].sort(
          (a, b) =>
            remaining(b) / b.weeklyTargetMin - remaining(a) / a.weeklyTargetMin ||
            a.priorityRank - b.priorityRank,
        )[0];
      // A deadline beats the weekly target: an urgent area gets its block even
      // when its target is met (a capped area still stops at its cap).
      const isUrgent = pick?.id === urgentPick;
      if (!pick || (!isUrgent && remaining(pick) <= 0)) continue;
      const minutes = pick.capped ? Math.min(duration, remaining(pick)) : duration;
      if (minutes < 25) continue;
      planned[pick.id] = (planned[pick.id] ?? 0) + minutes;
      used += minutes;
      // 4. The area's most pressing task goes into the block.
      const task = takeTask(pick.id);
      blocks.push({
        startMin: slot.startMin,
        durationMin: minutes,
        kind: "area",
        areaId: pick.id,
        taskId: task?.id ?? null,
        title: task ? `${pick.name}: ${task.title}` : pick.name,
      });
    }
  }

  blocks.sort((a, b) => a.startMin - b.startMin);

  // 6. Top 3.
  const top: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !top.includes(id) && top.length < (light ? 1 : 3)) top.push(id);
  };
  const known = new Set(input.tasks.map((task) => task.id));
  input.chosenTop.filter((id) => known.has(id)).forEach(add);
  urgent(input.tasks, input.date).forEach((task) => add(task.id));
  blocks.filter((block) => block.kind === "area").forEach((block) => add(block.taskId));

  return { light, blocks, top };
}
