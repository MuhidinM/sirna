/**
 * The AI touchpoints (plan §7.3). Each is a task: a fact sheet in, a small
 * checked JSON reply out. The numbers, verdicts and dates are always the
 * app's; the model only words them (ADR-0003). What goes out is titles,
 * area names, minutes, dates and energy, nothing else (§7.4, R-AI-02); in
 * strict mode titles are replaced by area names.
 */
import { readWhen } from "../../capture/when";
import { groundText, unknownIds } from "./ground";
import { unmask } from "./mask";
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

// --- Week paragraph (plan §3.10, card 1) -------------------------------------------

export interface WeekFacts {
  areas: { area: string; doneH: number; targetH: number }[];
  sessions: number;
  distractions: number;
  overrunDays: number;
  nextWeekLoad: number; // %
}

export const WEEK: AiTask<WeekFacts, { paragraph: string }> = {
  id: "week",
  version: "1",
  schema: s.object({
    paragraph: s.string({ maxLength: 520, description: "At most 80 words" }),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `hours this week vs target: ${f.areas.map((a) => `${a.area} ${a.doneH} of ${a.targetH} h`).join("; ") || "none"}`,
      `focus sessions finished: ${f.sessions}`,
      `distractions noted: ${f.distractions}`,
      `days past the focus cap: ${f.overrunDays}`,
      `next week's load: ${f.nextWeekLoad}% of free time`,
    ].join("\n"),
  ask: () =>
    "Write one short, kind paragraph (at most 80 words) on how the week went and what to keep in mind next week.",
  ground: (output, input) =>
    output.paragraph.split(/\s+/).length > 90
      ? "longer than 80 words"
      : groundText([output.paragraph], WEEK.facts(input)),
};

// --- Money advisor tip (proposal 3.1; T-064) ---------------------------------------

/** Names and ratios only: never an amount of money (R-AI-02). */
export type MoneyFacts = Record<string, string | number>;

export const MONEY: AiTask<MoneyFacts, { tip: string }> = {
  id: "money",
  version: "1",
  schema: s.object({
    tip: s.string({ maxLength: 160, description: "One practical sentence, at most 22 words" }),
  }),
  system: SYSTEM,
  facts: (f) =>
    Object.entries(f)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  ask: () =>
    "Give one calm, practical suggestion (at most 22 words) for this money finding. No amounts of money, no currency, no blame.",
  ground: (output, input) => {
    if (/\b(?:birr|etb|br)\b|\$|santim/i.test(output.tip)) return "names an amount of money";
    if (output.tip.split(/\s+/).length > 26) return "longer than 22 words";
    return groundText([output.tip], MONEY.facts(input));
  },
};

// --- Insight line (T-080) -----------------------------------------------------------

/** Two job names and the ratio of their pay per hour: never an amount of money (R-AI-02). */
export interface InsightFacts {
  best: string;
  other: string;
  ratio: number;
}

export const INSIGHT: AiTask<InsightFacts, { line: string }> = {
  id: "insight",
  version: "1",
  schema: s.object({
    line: s.string({ maxLength: 160, description: "One plain sentence, at most 22 words" }),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `job that pays more per hour worked: ${f.best}`,
      `job that pays less per hour worked: ${f.other}`,
      `ratio of their pay per hour worked: ${f.ratio}`,
    ].join("\n"),
  ask: () =>
    "Say this in one plain sentence (at most 22 words). Keep the ratio as given. No amounts of money, no advice to quit.",
  ground: (output, input) => {
    if (/\b(?:birr|etb|br)\b|\$|santim/i.test(output.line)) return "names an amount of money";
    if (output.line.split(/\s+/).length > 26) return "longer than 22 words";
    return groundText([output.line], INSIGHT.facts(input));
  },
};

// --- Smart capture in your own words (T-090, ADR-0014) ------------------------------

/** The closed list of things a line can ask for. App code does each one; the model only names it. */
export const INTENTS = [
  "task",
  "note",
  "money",
  "move",
  "finish_by",
  "day_mode",
  "place",
  "question",
] as const;
export type Intent = (typeof INTENTS)[number];

/** T-shirt sizes the model picks; code turns them into minutes. */
export const SIZE_MIN = { xs: 15, s: 30, m: 60, l: 120, xl: 240 } as const;
export type Size = keyof typeof SIZE_MIN;

export const PLACES = ["addis", "adama"] as const;
export type Place = (typeof PLACES)[number];

export interface CommandFacts {
  /** The typed line with money amounts masked (`lunch <a1>`). */
  text: string;
  /** Token → amount, to read the reply back. Never in the fact sheet. */
  amounts: Record<string, string>;
  today: string;
  weekday: string;
  /** For checking the date words in the reply. Never in the fact sheet. */
  nowMs: number;
  areas: { id: string; name: string }[];
  open: { id: string; title: string; kind: "task" | "project" }[];
}

export interface CommandItem {
  intent: Intent;
  title: string;
  area?: string;
  area_phrase?: string;
  when_text?: string;
  by_text?: string;
  ethiopian_clock?: boolean;
  size?: Size;
  steps?: string[];
  target?: string;
  mode?: "off" | "light" | "normal";
  place?: Place;
  span?: string;
  confidence: "low" | "medium" | "high";
}

export const COMMAND_MAX_ITEMS = 6;
const COMMAND_MAX_STEPS = 5;

export const COMMAND: AiTask<CommandFacts, { items: CommandItem[] }> = {
  id: "command",
  version: "1",
  schema: s.object({
    items: s.array(
      s.object(
        {
          intent: s.enum(INTENTS, "What the user asks for"),
          title: s.string({
            maxLength: 120,
            description:
              "Starts with a verb, in the user's own words; English if they wrote Amharic",
          }),
          area: s.string({ description: "One of the area ids, only if it clearly fits" }),
          area_phrase: s.string({ description: "The words in the line that named the area" }),
          when_text: s.string({
            description: "English date words for when: today, tomorrow, fri, 20 dec, at 3pm",
          }),
          by_text: s.string({ description: "English date words for a deadline (finish_by)" }),
          ethiopian_clock: s.boolean("True if the time is Ethiopian clock (ከጠዋቱ 3 = 9am)"),
          size: s.enum(Object.keys(SIZE_MIN), "How long: xs 15m, s 30m, m 1h, l 2h, xl 4h"),
          steps: s.array(s.string({ maxLength: 80 }), {
            maxItems: COMMAND_MAX_STEPS,
            description: "Only if the user listed steps",
          }),
          target: s.string({ description: "The id of an open task or project it is about" }),
          mode: s.enum(["off", "light", "normal"], "For day_mode"),
          place: s.enum(PLACES, "For place: where the user is"),
          span: s.string({
            description:
              "For money and question: the exact part of the line, copied character for character",
          }),
          confidence: s.enum(["low", "medium", "high"]),
        },
        [
          "area",
          "area_phrase",
          "when_text",
          "by_text",
          "ethiopian_clock",
          "size",
          "steps",
          "target",
          "mode",
          "place",
          "span",
        ],
      ),
      { maxItems: COMMAND_MAX_ITEMS },
    ),
  }),
  system: SYSTEM,
  facts: (f) =>
    [
      `today: ${f.today} (${f.weekday})`,
      `area ids: ${f.areas.map((a) => `${a.id} (${a.name})`).join("; ") || "none"}`,
      "open tasks and projects:",
      ...(f.open.length ? f.open.map((o) => `- ${o.id} (${o.kind}): ${o.title}`) : ["- none"]),
      `places: ${PLACES.join(", ")}`,
      `line: ${f.text}`,
    ].join("\n"),
  ask: () =>
    [
      `Read the line (English, Amharic or mixed) and list up to ${COMMAND_MAX_ITEMS} things it asks for, in order.`,
      "Intents: task (something to do), note (to remember), money (spent, earned, lent: copy the exact words as span),",
      "move (an open task to another day: target id and when_text), finish_by (must be done by a day: by_text, target id if it is an open task),",
      "day_mode (a day off, light or normal: mode and when_text), place (where the user is: addis or adama),",
      "question (looking something up: copy the words as span).",
      "Write when_text and by_text as short English date words. Tokens like <a1> are hidden amounts: copy them as they are.",
      "Leave out anything you are unsure of rather than guess.",
    ].join(" "),
  ground: (output, input) => groundCommand(output.items, input),
};

/** Every date word in a reply must be one our own reader understands. */
function readsAsDate(text: string, input: CommandFacts, ethiopian: boolean): boolean {
  const when = readWhen(
    unmask(text, input.amounts),
    input.nowMs,
    ethiopian ? "ethiopian" : "western",
  );
  return when.date !== undefined || when.minutes !== undefined || when.window !== undefined;
}

export function groundCommand(items: CommandItem[], input: CommandFacts): string | null {
  const areaIds = new Set(input.areas.map((a) => a.id));
  const openIds = new Set(input.open.map((o) => o.id));
  const line = input.text.toLowerCase();
  for (const [index, item] of items.entries()) {
    const at = `item ${index + 1}`;
    if (item.area && !areaIds.has(item.area)) return `${at}: unknown area ${item.area}`;
    if (item.target && !openIds.has(item.target)) return `${at}: unknown target ${item.target}`;
    if (item.span !== undefined && !input.text.includes(item.span))
      return `${at}: span is not in the line`;
    if (item.area_phrase && !line.includes(item.area_phrase.toLowerCase()))
      return `${at}: area words are not in the line`;
    const ethiopian = item.ethiopian_clock === true;
    if (item.when_text && !readsAsDate(item.when_text, input, ethiopian))
      return `${at}: can't read "${item.when_text}"`;
    if (item.by_text && !readsAsDate(item.by_text, input, ethiopian))
      return `${at}: can't read "${item.by_text}"`;
    const needs: Partial<Record<Intent, keyof CommandItem>> = {
      money: "span",
      question: "span",
      move: "target",
      finish_by: "by_text",
      day_mode: "mode",
      place: "place",
    };
    const field = needs[item.intent];
    if (field && (item[field] === undefined || item[field] === "")) return `${at}: no ${field}`;
    if (item.intent === "move" && !item.when_text) return `${at}: no when_text`;
    if ((item.intent === "task" || item.intent === "note") && !item.title.trim())
      return `${at}: no title`;
  }
  return groundText(
    items.flatMap((item) => [item.title, ...(item.steps ?? [])]),
    COMMAND.facts(input),
  );
}
