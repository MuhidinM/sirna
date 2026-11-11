/** The eval set files (plan §7.6), shared by the offline tests and `pnpm eval:ai`. */
import { readFileSync } from "node:fs";

import { type PlannedProject, type WeekModel } from "../projects/capacity";

export interface TimingCase {
  name: string;
  idea: string;
  today: string;
  week: WeekModel;
  projects: PlannedProject[];
  estimateMin: number;
  deadline?: string;
  weeklyMin?: number;
  verdict?: "good" | "tight" | "too_much";
  slot?: { start: string; finish: string } | null;
}

export interface CaptureCase {
  ref: string;
  text: string;
  kind: "task" | "note" | "idea";
  area: string | null;
}

export function readJsonl<T>(name: string): T[] {
  const text = readFileSync(new URL(`../../../evals/${name}`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}
