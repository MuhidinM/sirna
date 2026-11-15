/**
 * Birr per hour for each job (T-073; proposal 2.7): pay received this month
 * ÷ hours of that job's blocks, so a third job can be weighed. Hours come from
 * the days Sirna planned (a day the app never opened has no blocks). Pure.
 */
import { type Santim, SANTIM_PER_BIRR } from "../../kernel/money";

/** Minutes of each job's blocks between ?1 and ?2, up to now (?3); skipped or moved ones left out. */
export const JOB_MINUTES_SQL = `
  SELECT b.area_id, a.name, sum((MIN(b.end_at, ?3) - b.start_at) / 60000) AS minutes
  FROM day_blocks b
  JOIN area_items a ON a.id = b.area_id AND a.kind = 'work'
  WHERE b.deleted_at IS NULL AND b.status NOT IN ('skipped', 'moved')
    AND b.logical_date >= ?1 AND b.logical_date <= ?2 AND b.start_at < ?3
  GROUP BY b.area_id`;

/** Pay received per job between ?1 and ?2. */
export const JOB_PAY_SQL = `
  SELECT area_id, sum(amount_minor) AS minor FROM money_txns
  WHERE deleted_at IS NULL AND transfer_id IS NULL AND amount_minor > 0 AND area_id IS NOT NULL
    AND local_date >= ?1 AND local_date <= ?2
  GROUP BY area_id`;

export interface JobRate {
  areaId: string;
  name: string;
  pay: Santim;
  minutes: number;
  /** Rounded down to whole birr; null with no hours or no pay yet. */
  perHour: Santim | null;
}

export function jobRates(
  minutes: { area_id: string; name: string; minutes: number }[],
  pay: { area_id: string; minor: number }[],
): JobRate[] {
  return minutes
    .map((row) => {
      const paid = pay.find((p) => p.area_id === row.area_id)?.minor ?? 0;
      const perHour =
        row.minutes > 0 && paid > 0
          ? Math.floor((paid * 60) / row.minutes / SANTIM_PER_BIRR) * SANTIM_PER_BIRR
          : null;
      return { areaId: row.area_id, name: row.name, pay: paid, minutes: row.minutes, perHour };
    })
    .sort((a, b) => (b.perHour ?? -1) - (a.perHour ?? -1) || a.name.localeCompare(b.name));
}
