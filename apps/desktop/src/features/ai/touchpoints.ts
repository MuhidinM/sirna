/**
 * The AI touchpoints (plan §7.3). Each is a task: a fact sheet in, a small
 * checked JSON reply out. The numbers, verdicts and dates are always the
 * app's; the model only words them (ADR-0003). What goes out is titles,
 * area names, minutes, dates and energy, nothing else (§7.4, R-AI-02); in
 * strict mode titles are replaced by area names.
 */
import { groundText, unknownIds } from "./ground";
import { s } from "./schema";
import { type AiTask } from "./task";

const SYSTEM =
  "You are Sirna, a calm planning assistant. Use only the facts given. Never invent numbers, " +
  "dates or names; write numbers as digits and only ones that appear in the facts. Plain words, " +
  "short sentences, no hype, no guilt.";

/** In strict mode a title becomes "a <area> project/task". */
export function label(title: string, area: string | null, strict: boolean, noun = "item"): string {
  return strict ? `a ${area ?? "general"} ${noun}` : title;
}

// --- Timing check reasons (§3.8) ---------------------------------------------

export interface TimingFacts {
  idea: string;
  verdict: "Good" | "Tight" | "Too much";
  estimateH: number;
  deadline: string;
  weeklyNeeded: string; // "3 h 15"
  loadBefore: number; // %
  loadAfter: number; // %
  activeProjects: string[];
  suggestion: { start: string; finish: string } | null;
}

export const TIMING: AiTask<TimingFacts, { reasons: string[] }> = {
  id: "timing",
  version: "1",
  schema: s.object({
    reasons: s.array(s.string({ maxLength: 160 }), {
      maxItems: 3,
      description: "Up to 3 short reasons for the verdict, from the facts",
    }),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `idea: ${f.idea}`,
      `verdict (fixed, from the app): ${f.verdict}`,
      `estimate: ${f.estimateH} h`,
      `deadline: ${f.deadline}`,
      `needs per week: ${f.weeklyNeeded}`,
      `weekly load now: ${f.loadBefore}%`,
      `weekly load with it: ${f.loadAfter}%`,
      `active projects: ${f.activeProjects.length ? f.activeProjects.join("; ") : "none"} (${f.activeProjects.length})`,
      `fits without overload: ${f.suggestion ? `start ${f.suggestion.start}, finish ${f.suggestion.finish}` : "no slot in a year"}`,
    ].join("\n"),
  ask: () =>
    "Explain the verdict in up to 3 short reasons a tired person can read in 5 seconds. Do not change or restate the verdict as a different one.",
  ground: (output, input) => groundText(output.reasons, TIMING.facts(input)),
};

// --- Estimate for an idea without hours (§7.3) ----------------------------------

export interface EstimateFacts {
  idea: string;
  area: string | null;
  /** Finished or estimated projects, for scale: "Portfolio site: 20 h". */
  similar: string[];
}

export interface EstimateReply {
  estimate_h: number;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
}

export const ESTIMATE: AiTask<EstimateFacts, EstimateReply> = {
  id: "estimate",
  version: "1",
  schema: s.object({
    estimate_h: s.number({ min: 0.5, max: 500, description: "Total hours of focused work" }),
    confidence: s.enum(["low", "medium", "high"]),
    assumptions: s.array(s.string({ maxLength: 120 }), { maxItems: 2 }),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `idea: ${f.idea}`,
      `area: ${f.area ?? "none"}`,
      `other projects for scale: ${f.similar.length ? f.similar.join("; ") : "none yet"}`,
    ].join("\n"),
  ask: () =>
    "Estimate the total focused hours this idea needs for one person working alone. Give at most 2 short assumptions.",
  // The estimate is the one number the model may suggest; assumptions may use it too.
  ground: (output, input) =>
    groundText(output.assumptions, `${ESTIMATE.facts(input)}\n${output.estimate_h}`),
};

// --- Brief line (§3.4) ----------------------------------------------------------

export interface BriefFacts {
  blocks: { area: string; minutes: number }[];
  top: string[];
  behind: { area: string; percent: number }[];
}

export const BRIEF: AiTask<BriefFacts, { line: string }> = {
  id: "brief",
  version: "1",
  schema: s.object({ line: s.string({ maxLength: 140, description: "At most 20 words" }) }),
  system: SYSTEM,
  facts: (f) =>
    [
      `today's blocks: ${f.blocks.map((b) => `${b.area} ${b.minutes} min`).join("; ") || "none"}`,
      `top 3: ${f.top.join("; ") || "none"}`,
      `areas behind this week: ${f.behind.map((b) => `${b.area} at ${b.percent}%`).join("; ") || "none"}`,
    ].join("\n"),
  ask: () =>
    "Write one encouraging, concrete line (at most 20 words) about what matters most today.",
  ground: (output, input) =>
    output.line.split(/\s+/).length > 24
      ? "longer than 20 words"
      : groundText([output.line], BRIEF.facts(input)),
};

// --- Night review free text (§3.9) ------------------------------------------------

export interface ReviewFacts {
  mind: string;
  energy: number | null;
  doneToday: number;
}

export const REVIEW: AiTask<ReviewFacts, { reply: string }> = {
  id: "review",
  version: "1",
  schema: s.object({ reply: s.string({ maxLength: 240, description: "At most 40 words" }) }),
  system: SYSTEM,
  facts: (f) =>
    [
      `what is on their mind: ${f.mind}`,
      `energy tonight (1 drained, 3 good): ${f.energy ?? "not given"}`,
      `tasks done today: ${f.doneToday}`,
    ].join("\n"),
  ask: () =>
    "Reply kindly in at most 40 words. If it is a worry, name one small next step for tomorrow. No advice about health or money.",
  ground: (output, input) => groundText([output.reply], REVIEW.facts(input)),
};

// --- Capture fallback for loose ends (§7.3) ----------------------------------------

export interface CaptureFacts {
  notes: { ref: string; body: string }[];
  areas: { id: string; name: string }[];
}

export interface CaptureGuess {
  ref: string;
  kind: "task" | "note" | "idea";
  area: string | null;
  title: string;
  when_text: string | null;
  confidence: "low" | "medium" | "high";
}

export const CAPTURE: AiTask<CaptureFacts, { items: CaptureGuess[] }> = {
  id: "capture",
  version: "1",
  schema: s.object({
    items: s.array(
      s.object(
        {
          ref: s.string(),
          kind: s.enum(["task", "note", "idea"]),
          area: s.string({ description: "One of the area ids, or omit" }),
          title: s.string({ maxLength: 120 }),
          when_text: s.string({ description: "Date words copied from the note, or omit" }),
          confidence: s.enum(["low", "medium", "high"]),
        },
        ["area", "when_text"],
      ),
      { maxItems: 10 },
    ),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      "notes:",
      ...f.notes.map((note) => `- ref ${note.ref}: ${note.body}`),
      `area ids: ${f.areas.map((a) => `${a.id} (${a.name})`).join("; ")}`,
    ].join("\n"),
  ask: () =>
    "For each note say whether it is a task, a note or an idea, its area id if one clearly fits, a short title, and any date words it contains.",
  ground: (output, input) => {
    const refs = unknownIds(
      output.items.map((item) => item.ref),
      input.notes.map((n) => n.ref),
    );
    if (refs.length) return `unknown refs: ${refs.join(", ")}`;
    const areas = unknownIds(
      output.items.flatMap((item) => (item.area ? [item.area] : [])),
      input.areas.map((a) => a.id),
    );
    if (areas.length) return `unknown areas: ${areas.join(", ")}`;
    return groundText(
      output.items.flatMap((item) => [item.title, item.when_text ?? ""]),
      CAPTURE.facts(input),
    );
  },
};

// --- Split a big task into steps (spread over days by the planner) ---------------

export interface SplitFacts {
  task: string;
  area: string | null;
  estimateMin: number;
  due: string | null;
}

export interface SplitReply {
  steps: { title: string; minutes: number }[];
}

export const SPLIT_TOLERANCE = 0.1;
/** 6 steps of at most 240 min: anything bigger is a project, not a task. */
export const SPLIT_MAX_MIN = 6 * 240;

export const SPLIT: AiTask<SplitFacts, SplitReply> = {
  id: "split",
  version: "1",
  schema: s.object({
    steps: s.array(
      s.object({
        title: s.string({ maxLength: 80, description: "A concrete step that starts with a verb" }),
        minutes: s.integer({ min: 10, max: 240 }),
      }),
      { maxItems: 6 },
    ),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `task: ${f.task}`,
      `area: ${f.area ?? "none"}`,
      `estimate: ${f.estimateMin} min`,
      `due: ${f.due ?? "no date"}`,
    ].join("\n"),
  ask: (f) =>
    `Break the task into 2 to 6 steps someone can each finish in one sitting. The minutes must add up to about ${f.estimateMin}.`,
  // Step titles carry no new numbers; the minutes are the split itself and
  // must add up to the estimate (within 10%).
  ground: (output, input) => {
    if (output.steps.length < 2) return "fewer than 2 steps";
    const total = output.steps.reduce((sum, step) => sum + step.minutes, 0);
    if (Math.abs(total - input.estimateMin) > input.estimateMin * SPLIT_TOLERANCE)
      return `steps add up to ${total} min, not ${input.estimateMin}`;
    return groundText(
      output.steps.map((step) => step.title),
      SPLIT.facts(input),
    );
  },
};
