/** Turns the setup answers into database writes (plan §3.1). Pure and tested. */
import { type Op } from "../../kernel/db";
import { type ClockStyle } from "../../capture/when";
import { areaId } from "./editor";
import { defaultRoutine, type JobAnswer, type SetupAnswers } from "./routine";

export const SETUP_DONE_KEY = "setup.done";

export interface SetupChoices extends SetupAnswers {
  clockStyle: ClockStyle;
  /** Weekly target per area id, in hours. */
  targetsHours: Record<string, number>;
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * A new job row: the first free "Job A", "Job B", … name, Mon–Fri 09:00–17:00,
 * and an id no area has used ("Job C" → "job-c").
 */
export function newJob(takenIds: Iterable<string>, takenNames: Iterable<string>): JobAnswer {
  const names = new Set([...takenNames].map((name) => name.trim().toLowerCase()));
  const letter = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    .split("")
    .find((l) => !names.has(`job ${l.toLowerCase()}`));
  const name = letter ? `Job ${letter}` : "Job";
  return {
    areaId: areaId(name, takenIds),
    name,
    days: [1, 2, 3, 4, 5],
    parts: [{ start: "09:00", end: "17:00" }],
  };
}

/**
 * `allAreaIds` are the saved areas setup switches on or off: every job (removed
 * ones too) and the fixed list. A job not in `existingAreaIds` is new and gets
 * its area row here, before the routine blocks that point at it; left out,
 * every job counts as saved.
 */
export function setupOps(
  choices: SetupChoices,
  existingBlockIds: string[],
  allAreaIds: string[],
  newId: () => string,
  existingAreaIds: Iterable<string> = choices.jobs.map((job) => job.areaId),
): Op[] {
  const ops: Op[] = [];
  const setting = (key: string, value: unknown) =>
    ops.push({
      op: "upsert",
      table: "core_settings",
      id: key,
      values: { value_json: json(value) },
    });

  setting("day.wake", choices.wake);
  setting("day.hard_stop", choices.hardStop);
  setting("day.review", choices.review);
  setting("capture.clock_style", choices.clockStyle);
  setting("setup.answers", {
    jobs: choices.jobs,
    restDay: choices.restDay,
    gymDays: choices.gymDays,
    gymTime: choices.gymTime,
    emailChecks: choices.emailChecks,
    lunch: choices.lunch ?? "",
  });

  const active = new Set(choices.activeAreas);
  for (const id of allAreaIds) {
    const values: Record<string, number> = { active: active.has(id) ? 1 : 0 };
    const hours = choices.targetsHours[id];
    if (hours !== undefined && Number.isFinite(hours) && hours >= 0)
      values.weekly_target_min = Math.round(hours * 60);
    ops.push({ op: "update", table: "area_items", id, values });
  }
  const saved = new Set(existingAreaIds);
  for (const job of choices.jobs) {
    if (saved.has(job.areaId)) {
      ops.push({ op: "update", table: "area_items", id: job.areaId, values: { name: job.name } });
      continue;
    }
    // Like the seeded Job A and Job B (migration 0007).
    ops.push({
      op: "insert",
      table: "area_items",
      id: job.areaId,
      values: {
        name: job.name,
        kind: "work",
        color: "work",
        weekly_target_min: 0,
        capped: 0,
        protected: 0,
        priority_rank: 2,
        active: active.has(job.areaId) ? 1 : 0,
      },
    });
  }

  // Running setup again replaces the routine.
  for (const id of existingBlockIds) ops.push({ op: "delete", table: "routine_blocks", id });
  for (const block of defaultRoutine(choices)) {
    ops.push({
      op: "insert",
      table: "routine_blocks",
      id: newId(),
      values: {
        weekday: block.weekday,
        start_min: block.startMin,
        duration_min: block.durationMin,
        kind: block.kind,
        area_id: block.areaId,
        title: block.title,
      },
    });
  }

  setting(SETUP_DONE_KEY, true);
  return ops;
}
