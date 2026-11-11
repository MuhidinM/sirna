/** Turns the setup answers into database writes (plan §3.1). Pure and tested. */
import { type Op } from "../../kernel/db";
import { type ClockStyle } from "../../capture/when";
import { defaultRoutine, type SetupAnswers } from "./routine";

export const SETUP_DONE_KEY = "setup.done";

export interface SetupChoices extends SetupAnswers {
  clockStyle: ClockStyle;
  /** Weekly target per area id, in hours. */
  targetsHours: Record<string, number>;
}

const json = (value: unknown) => JSON.stringify(value);

export function setupOps(
  choices: SetupChoices,
  existingBlockIds: string[],
  allAreaIds: string[],
  newId: () => string,
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
  });

  const active = new Set(choices.activeAreas);
  for (const id of allAreaIds) {
    const values: Record<string, number> = { active: active.has(id) ? 1 : 0 };
    const hours = choices.targetsHours[id];
    if (hours !== undefined && Number.isFinite(hours) && hours >= 0)
      values.weekly_target_min = Math.round(hours * 60);
    ops.push({ op: "update", table: "area_items", id, values });
  }
  for (const job of choices.jobs) {
    ops.push({ op: "update", table: "area_items", id: job.areaId, values: { name: job.name } });
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
