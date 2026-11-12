import { useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { type Op, query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  addAreaOps,
  addBlockOps,
  AREA_COLORS,
  AREA_KINDS,
  areaDraftOf,
  type AreaDraft,
  type AreaRow,
  AREAS_SQL,
  BLOCK_KINDS,
  type BlockDraft,
  checkArea,
  checkBlock,
  clashes,
  draftOf,
  duplicateOf,
  EMPTY_AREA,
  removeBlockOps,
  ROUTINE_SQL,
  type RoutineRow,
  seriesOf,
  setAreaActiveOps,
  updateAreaOps,
  updateBlockOps,
  WEEKDAYS,
} from "../features/plan/editor";
import { isoWeekday, replanDay, shiftDate } from "../features/plan/dayplan";
import { toHhmm, type Weekday } from "../features/plan/routine";
import { type AreaColor, Button, Chip } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const dayName = (day: number) => WEEKDAYS.find(([d]) => d === day)?.[1] ?? "";
const kindLabel = (kind: string) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/**
 * Saves routine changes, then plans today again (and tomorrow, if the night
 * review already planned it) around the blocks you touched.
 */
async function saveRoutine(ops: Op[]): Promise<void> {
  await transact("user", ops, "routine");
  const today = logicalDate(systemClock.now());
  for (const date of [today, shiftDate(today, 1)])
    await replanDay(
      query,
      (plan) => transact("system", plan, "day-plan"),
      date,
      () => ulid(),
    );
}

function DayPicker({ value, onChange }: { value: Weekday[]; onChange: (days: Weekday[]) => void }) {
  return (
    <fieldset className="days">
      <legend className="visually-hidden">Days</legend>
      {WEEKDAYS.map(([day, name]) => (
        <label key={day} className={value.includes(day) ? "day on" : "day"}>
          <input
            type="checkbox"
            checked={value.includes(day)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, day].sort((a, b) => a - b)
                  : value.filter((d) => d !== day),
              )
            }
          />
          {name}
        </label>
      ))}
    </fieldset>
  );
}

function BlockForm({
  rows,
  areas,
  initial,
  editing,
  onDone,
}: {
  rows: RoutineRow[];
  areas: AreaRow[];
  initial: BlockDraft;
  editing: RoutineRow | null;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const series = editing ? seriesOf(rows, editing) : [];
  const [scope, setScope] = useState<"series" | "day">("series");
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<BlockDraft>) => {
    setError(null);
    setDraft({ ...draft, ...change });
  };
  const ignore = new Set(
    scope === "series" ? series.map((r) => r.id) : editing ? [editing.id] : [],
  );
  const shared = (scope === "day" && editing ? [editing.weekday as Weekday] : draft.days).flatMap(
    (day) => clashes(rows, draft, day, ignore).map((row) => `${dayName(day)} ${row.title}`),
  );
  const active = areas.filter((area) => area.active === 1 || area.id === draft.areaId);
  return (
    <form
      className="card block-form"
      onSubmit={(event) => {
        event.preventDefault();
        const effective =
          scope === "day" && editing ? { ...draft, days: [editing.weekday as Weekday] } : draft;
        const problem = checkBlock(effective);
        if (problem) {
          setError(problem);
          return;
        }
        const twin = duplicateOf(rows, effective, effective.days, ignore);
        if (twin) {
          setError(
            `${dayName(twin.weekday)} already has ${twin.title} at ${draft.start}. Change the name or time.`,
          );
          return;
        }
        const ops = editing
          ? updateBlockOps(rows, editing, effective, scope, () => ulid())
          : addBlockOps(effective, () => ulid());
        saveRoutine(ops)
          .then(onDone)
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <h3>{editing ? "Change block" : "Add a block"}</h3>
      <div className="row">
        <label className="field">
          <span>Name</span>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the form opens on request; focus shows it
            autoFocus
            value={draft.title}
            placeholder={draft.kind === "area" ? "Focus block" : "e.g. Gym"}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as BlockDraft["kind"] })}
          >
            {BLOCK_KINDS.map(({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {draft.kind !== "rest" && (
          <label className="field">
            <span>Area{draft.kind === "area" ? " (optional)" : ""}</span>
            <select value={draft.areaId} onChange={(e) => set({ areaId: e.target.value })}>
              <option value="">{draft.kind === "area" ? "Most behind" : "Pick one"}</option>
              {active.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>From</span>
          <input type="time" value={draft.start} onChange={(e) => set({ start: e.target.value })} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="time" value={draft.end} onChange={(e) => set({ end: e.target.value })} />
        </label>
      </div>
      <p className="meta">{BLOCK_KINDS.find((k) => k.kind === draft.kind)?.help}</p>
      {editing && series.length > 1 && (
        <div className="row" role="radiogroup" aria-label="Change which days">
          <label className="check">
            <input type="radio" checked={scope === "series"} onChange={() => setScope("series")} />
            Every day it&apos;s on
          </label>
          <label className="check">
            <input type="radio" checked={scope === "day"} onChange={() => setScope("day")} />
            Only {dayName(editing.weekday)}
          </label>
        </div>
      )}
      {!(editing && scope === "day") && (
        <DayPicker value={draft.days} onChange={(days) => set({ days })} />
      )}
      {shared.length > 0 && (
        <p className="meta" role="status">
          Shares time with: {shared.join(", ")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <Button type="submit" primary>
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function RoutineTab({ rows, areas }: { rows: RoutineRow[]; areas: AreaRow[] }) {
  const [day, setDay] = useState<Weekday>(
    () => isoWeekday(logicalDate(systemClock.now())) as Weekday,
  );
  const [form, setForm] = useState<{ editing: RoutineRow | null; draft: BlockDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const onDay = rows.filter((row) => row.weekday === day);
  const remove = (row: RoutineRow, scope: "day" | "series") =>
    saveRoutine(removeBlockOps(rows, row, scope)).catch((failure: unknown) =>
      setError(`Couldn't remove it: ${message(failure)}`),
    );
  return (
    <section aria-label="Routine">
      <div className="row" role="tablist" aria-label="Day">
        {WEEKDAYS.map(([d, name]) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === day}
            className={d === day ? "step current" : "step"}
            onClick={() => {
              setDay(d);
              setForm(null);
            }}
          >
            {name} <span className="meta">{rows.filter((r) => r.weekday === d).length}</span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul className="routine-list">
        {onDay.length === 0 && <li className="meta">Nothing on {dayName(day)} yet.</li>}
        {onDay.map((row) => {
          const area = row.area_id ? areaById.get(row.area_id) : undefined;
          const series = seriesOf(rows, row);
          return (
            <li key={row.id} className="task">
              <span>
                <span className="meta">
                  {toHhmm(row.start_min)}–{toHhmm(row.start_min + row.duration_min)}
                </span>{" "}
                {row.title} {area && <Chip area={area.color as AreaColor}>{area.name}</Chip>}{" "}
                <span className="meta">
                  {kindLabel(row.kind)}
                  {series.length > 1 ? ` · ${series.map((r) => dayName(r.weekday)).join(" ")}` : ""}
                </span>
              </span>
              <span className="row">
                <Button
                  onClick={() =>
                    setForm({
                      editing: row,
                      draft: draftOf(
                        row,
                        series.map((r) => r.weekday as Weekday),
                      ),
                    })
                  }
                >
                  Change
                </Button>
                <Button onClick={() => void remove(row, "day")}>
                  Remove{series.length > 1 ? ` on ${dayName(row.weekday)}` : ""}
                </Button>
                {series.length > 1 && (
                  <Button onClick={() => void remove(row, "series")}>Remove all</Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {form ? (
        <BlockForm
          key={form.editing?.id ?? `new-${day}`}
          rows={rows}
          areas={areas}
          initial={form.draft}
          editing={form.editing}
          onDone={() => setForm(null)}
        />
      ) : (
        <Button
          primary
          onClick={() =>
            setForm({
              editing: null,
              draft: {
                title: "",
                kind: "routine",
                areaId: "",
                start: "07:00",
                end: "07:30",
                days: [day],
              },
            })
          }
        >
          Add a block
        </Button>
      )}
    </section>
  );
}

function AreaForm({
  areas,
  editing,
  onDone,
}: {
  areas: AreaRow[];
  editing: AreaRow | null;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<AreaDraft>(editing ? areaDraftOf(editing) : EMPTY_AREA);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<AreaDraft>) => {
    setError(null);
    setDraft({ ...draft, ...change });
  };
  return (
    <form
      className="card block-form"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkArea(draft, areas, editing?.id ?? null);
        if (problem) {
          setError(problem);
          return;
        }
        const ops = editing
          ? updateAreaOps(editing.id, draft)
          : addAreaOps(
              draft,
              areas.map((area) => area.id),
            ).ops;
        saveRoutine(ops)
          .then(onDone)
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <h3>{editing ? `Change ${editing.name}` : "Add an area"}</h3>
      <div className="row">
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="e.g. Job C, Music"
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as AreaDraft["kind"] })}
          >
            {AREA_KINDS.map(({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Hours a week</span>
          <input
            inputMode="decimal"
            value={draft.weeklyHours}
            onChange={(e) => set({ weeklyHours: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Priority (1 first)</span>
          <input
            inputMode="numeric"
            value={draft.priority}
            onChange={(e) => set({ priority: e.target.value })}
          />
        </label>
      </div>
      <p className="meta">{AREA_KINDS.find((k) => k.kind === draft.kind)?.help}</p>
      <fieldset className="row colors">
        <legend>Colour</legend>
        {AREA_COLORS.map((color) => (
          <label key={color} className={draft.color === color ? "swatch on" : "swatch"}>
            <input
              type="radio"
              name="color"
              checked={draft.color === color}
              onChange={() => set({ color })}
            />
            <span style={{ background: `var(--area-${color})` }} aria-label={color} />
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.capped}
          onChange={(e) => set({ capped: e.target.checked })}
        />
        Never more than its hours a week (capped)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.protected}
          onChange={(e) => set({ protected: e.target.checked })}
        />
        Protected: never dropped for work
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <Button type="submit" primary>
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function AreasTab({ rows, areas }: { rows: RoutineRow[]; areas: AreaRow[] }) {
  const [form, setForm] = useState<{ editing: AreaRow | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Areas">
      <p className="meta">
        Jobs are areas too: add one, then give it Fixed blocks in Routine. Grow and Admin areas fill
        free slots by their hours a week.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul className="routine-list">
        {areas.map((area) => {
          const blocks = rows.filter((row) => row.area_id === area.id).length;
          return (
            <li key={area.id} className={area.active === 1 ? "task" : "task off"}>
              <span>
                <Chip area={area.color as AreaColor}>{area.name}</Chip>{" "}
                <span className="meta">
                  {AREA_KINDS.find((k) => k.kind === area.kind)?.label} ·{" "}
                  {Math.round((area.weekly_target_min / 60) * 100) / 100} h/week · {blocks} block
                  {blocks === 1 ? "" : "s"}
                  {area.capped ? " · capped" : ""}
                  {area.protected ? " · protected" : ""}
                  {area.active === 1 ? "" : " · off"}
                </span>
              </span>
              <span className="row">
                <Button onClick={() => setForm({ editing: area })}>Change</Button>
                <Button
                  onClick={() =>
                    void saveRoutine(setAreaActiveOps(area.id, area.active !== 1, rows)).catch(
                      (failure: unknown) => setError(`Couldn't change it: ${message(failure)}`),
                    )
                  }
                  title={
                    area.active === 1 && blocks > 0
                      ? `Its ${blocks} block${blocks === 1 ? "" : "s"} leave the routine`
                      : undefined
                  }
                >
                  {area.active === 1 ? "Turn off" : "Turn on"}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      {form ? (
        <AreaForm
          key={form.editing?.id ?? "new"}
          areas={areas}
          editing={form.editing}
          onDone={() => setForm(null)}
        />
      ) : (
        <Button primary onClick={() => setForm({ editing: null })}>
          Add an area
        </Button>
      )}
    </section>
  );
}

const TIMES_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN ('day.wake', 'day.review', 'day.hard_stop')`;

function TimesTab() {
  const rows = useLiveQuery<{ key: string; value_json: string }>(TIMES_SQL);
  const [note, setNote] = useState("");
  if (rows.loading) return null;
  const read = (key: string, fallback: string) => {
    try {
      const value = JSON.parse(
        rows.rows.find((r) => r.key === key)?.value_json ?? "null",
      ) as unknown;
      return typeof value === "string" ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const fields: [string, string, string][] = [
    ["day.wake", "Wake", read("day.wake", "06:00")],
    ["day.review", "Night review", read("day.review", "21:00")],
    ["day.hard_stop", "Hard stop", read("day.hard_stop", "22:30")],
  ];
  return (
    <section aria-label="Day times" className="row">
      {fields.map(([key, label, value]) => (
        <label key={key} className="field">
          <span>{label}</span>
          <input
            type="time"
            defaultValue={value}
            onBlur={(event) => {
              if (!event.target.value || event.target.value === value) return;
              transact(
                "user",
                [
                  {
                    op: "upsert",
                    table: "core_settings",
                    id: key,
                    values: { value_json: JSON.stringify(event.target.value) },
                  },
                ],
                "settings",
              )
                .then(() => setNote(`${label} saved`))
                .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
            }}
          />
        </label>
      ))}
      <span className="meta" role="status">
        {note}
      </span>
    </section>
  );
}

function StartOver({ onStartOver }: { onStartOver: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <p className="meta start-over">
      Want a fresh routine from a few questions instead?{" "}
      {sure ? (
        <>
          Saving those answers replaces your whole routine (areas you added stay).{" "}
          <Button onClick={onStartOver}>Show the questions</Button>{" "}
          <Button onClick={() => setSure(false)}>Keep my routine</Button>
        </>
      ) : (
        <Button onClick={() => setSure(true)}>Start over</Button>
      )}
    </p>
  );
}

/** My week (plan §3.2): the routine, the areas and the day's times, all editable. */
export function Week({ onStartOver }: { onStartOver: () => void }) {
  const rows = useLiveQuery<RoutineRow & Record<string, string | number | null>>(ROUTINE_SQL);
  const areas = useLiveQuery<AreaRow & Record<string, string | number | null>>(AREAS_SQL);
  const [tab, setTab] = useState<"routine" | "areas" | "times">("routine");
  return (
    <main className="review week">
      <header className="review-head">
        <h1>My week</h1>
        <p className="meta">
          Your routine repeats every week. Changes apply from today: Sirna plans today again.
        </p>
        <div className="row" role="tablist" aria-label="Part">
          {(
            [
              ["routine", "Routine"],
              ["areas", "Areas"],
              ["times", "Day times"],
            ] as const
          ).map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? "step current" : "step"}
              onClick={() => setTab(name)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {(rows.error ?? areas.error) && (
        <p role="alert" className="error">
          Couldn&apos;t load your week: {rows.error ?? areas.error}
        </p>
      )}
      {!rows.loading && !areas.loading && tab === "routine" && (
        <RoutineTab rows={rows.rows} areas={areas.rows} />
      )}
      {!rows.loading && !areas.loading && tab === "areas" && (
        <AreasTab rows={rows.rows} areas={areas.rows} />
      )}
      {tab === "times" && <TimesTab />}
      <StartOver onStartOver={onStartOver} />
    </main>
  );
}
