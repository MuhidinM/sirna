import "../theme/pages/plan-routine.css";

import { type CSSProperties, useState } from "react";

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
import { IconArrowUpRight, IconClock, IconPlus } from "./icons";
import { EventCard, PanelHead, type Tone, toneOf } from "./kit";
import { Segmented } from "./Nav";
import { type AreaColor, Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const dayName = (day: number) => WEEKDAYS.find(([d]) => d === day)?.[1] ?? "";
const kindLabel = (kind: string) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

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
    <fieldset className="days rt-days">
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

type BlockFormState = { editing: RoutineRow | null; draft: BlockDraft };

const newBlock = (day: Weekday): BlockFormState => ({
  editing: null,
  draft: { title: "", kind: "routine", areaId: "", start: "07:00", end: "07:30", days: [day] },
});

function BlockForm({
  rows,
  areas,
  initial,
  editing,
  onRemove,
  onDone,
}: {
  rows: RoutineRow[];
  areas: AreaRow[];
  initial: BlockDraft;
  editing: RoutineRow | null;
  onRemove: (row: RoutineRow, scope: "day" | "series") => void;
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
      className="card block-form rt-form"
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
      <div className="rt-form-head">
        <h2>{editing ? "Change block" : "Add a block"}</h2>
        {editing && <span className="meta">{dayName(editing.weekday)}</span>}
      </div>
      <div className="rt-fields">
        <label className="field rt-wide">
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
        <div className="rt-scope" role="radiogroup" aria-label="Change which days">
          <label className={scope === "series" ? "rt-option on" : "rt-option"}>
            <input type="radio" checked={scope === "series"} onChange={() => setScope("series")} />
            Every day it&apos;s on
          </label>
          <label className={scope === "day" ? "rt-option on" : "rt-option"}>
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
      <div className="rt-actions">
        <Button type="submit" className="btn-orange">
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
        {editing && (
          <>
            <span className="rt-spacer" />
            <Button className="btn-ghost btn-danger" onClick={() => onRemove(editing, "day")}>
              Remove{series.length > 1 ? ` on ${dayName(editing.weekday)}` : ""}
            </Button>
            {series.length > 1 && (
              <Button className="btn-ghost btn-danger" onClick={() => onRemove(editing, "series")}>
                Remove all
              </Button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

/** The card's colour: the block's area, grey for rest. */
function toneFor(row: RoutineRow, area: AreaRow | undefined): Tone {
  if (row.kind === "rest") return "raised";
  return area ? toneOf(area.color) : "cream";
}

function RoutineTab({
  rows,
  areas,
  today,
  form,
  setForm,
}: {
  rows: RoutineRow[];
  areas: AreaRow[];
  today: Weekday;
  form: BlockFormState | null;
  setForm: (form: BlockFormState | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const remove = (row: RoutineRow, scope: "day" | "series") =>
    saveRoutine(removeBlockOps(rows, row, scope))
      .then(() => setForm(null))
      .catch((failure: unknown) => setError(`Couldn't remove it: ${message(failure)}`));
  return (
    <section aria-label="Routine" className="rt-routine">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {form && (
        <BlockForm
          key={form.editing?.id ?? `new-${form.draft.days.join("")}`}
          rows={rows}
          areas={areas}
          initial={form.draft}
          editing={form.editing}
          onRemove={(row, scope) => void remove(row, scope)}
          onDone={() => setForm(null)}
        />
      )}
      <div className="rt-board-wrap">
        <div className="rt-board">
          {WEEKDAYS.map(([day, name]) => {
            const onDay = rows.filter((row) => row.weekday === day);
            const minutes = onDay.reduce((sum, row) => sum + row.duration_min, 0);
            return (
              <section
                key={day}
                className={day === today ? "rt-col today" : "rt-col"}
                aria-label={`${name}, ${onDay.length} block${onDay.length === 1 ? "" : "s"}`}
              >
                <header className="rt-col-head">
                  <span className="rt-day">{name}</span>
                  <span className="rt-col-hours">{hours(minutes)} h</span>
                </header>
                {onDay.length === 0 ? (
                  <p className="rt-none">Nothing on {name} yet.</p>
                ) : (
                  <ul className="rt-cards">
                    {onDay.map((row) => {
                      const area = row.area_id ? areaById.get(row.area_id) : undefined;
                      const series = seriesOf(rows, row);
                      const style = { "--len": row.duration_min } as CSSProperties;
                      return (
                        <li key={row.id}>
                          <EventCard
                            tone={toneFor(row, area)}
                            label={`${toHhmm(row.start_min)}–${toHhmm(row.start_min + row.duration_min)}`}
                            title={row.title}
                            className={form?.editing?.id === row.id ? "rt-card editing" : "rt-card"}
                            style={style}
                          >
                            <span className="rt-card-meta">
                              {kindLabel(row.kind)}
                              {area ? ` · ${area.name}` : ""}
                            </span>
                            {series.length > 1 && (
                              <span className="rt-card-days">
                                {series.map((r) => dayName(r.weekday)).join(" ")}
                              </span>
                            )}
                            <button
                              type="button"
                              className="rt-card-open"
                              aria-label={`Change ${row.title} on ${name}`}
                              onClick={() =>
                                setForm({
                                  editing: row,
                                  draft: draftOf(
                                    row,
                                    series.map((r) => r.weekday as Weekday),
                                  ),
                                })
                              }
                            />
                          </EventCard>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  type="button"
                  className="rt-add"
                  aria-label={`Add a block on ${name}`}
                  onClick={() => setForm(newBlock(day))}
                >
                  <IconPlus size={14} /> Add
                </button>
              </section>
            );
          })}
        </div>
      </div>
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
      className="card block-form rt-form"
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
      <div className="rt-form-head">
        <h2>{editing ? `Change ${editing.name}` : "Add an area"}</h2>
      </div>
      <div className="rt-fields">
        <label className="field rt-wide">
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
      <fieldset className="colors rt-colors">
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
      <div className="rt-checks">
        <label className="check rt-option">
          <input
            type="checkbox"
            checked={draft.capped}
            onChange={(e) => set({ capped: e.target.checked })}
          />
          Never more than its hours a week (capped)
        </label>
        <label className="check rt-option">
          <input
            type="checkbox"
            checked={draft.protected}
            onChange={(e) => set({ protected: e.target.checked })}
          />
          Protected: never dropped for work
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="rt-actions">
        <Button type="submit" className="btn-orange">
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function AreasTab({
  rows,
  areas,
  form,
  setForm,
}: {
  rows: RoutineRow[];
  areas: AreaRow[];
  form: { editing: AreaRow | null } | null;
  setForm: (form: { editing: AreaRow | null } | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Areas" className="rt-areas-tab">
      <p className="meta rt-lead">
        Jobs are areas too: add one, then give it Fixed blocks in Routine. Grow and Admin areas fill
        free slots by their hours a week.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {form && (
        <AreaForm
          key={form.editing?.id ?? "new"}
          areas={areas}
          editing={form.editing}
          onDone={() => setForm(null)}
        />
      )}
      <ul className="rt-areas">
        {areas.map((area) => {
          const blocks = rows.filter((row) => row.area_id === area.id).length;
          const on = area.active === 1;
          return (
            <li key={area.id}>
              <EventCard
                tone={toneOf(area.color)}
                label={AREA_KINDS.find((k) => k.kind === area.kind)?.label}
                title={area.name}
                faded={!on}
                className={form?.editing?.id === area.id ? "rt-card editing" : "rt-card"}
              >
                <span className="rt-card-meta">
                  {hours(area.weekly_target_min)} h/week · {blocks} block
                  {blocks === 1 ? "" : "s"}
                  {area.capped ? " · capped" : ""}
                  {area.protected ? " · protected" : ""}
                  {on ? "" : " · off"}
                </span>
                <span className="rt-card-acts">
                  <button
                    type="button"
                    className="rt-card-btn"
                    onClick={() => setForm({ editing: area })}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="rt-card-btn"
                    onClick={() =>
                      void saveRoutine(setAreaActiveOps(area.id, !on, rows)).catch(
                        (failure: unknown) => setError(`Couldn't change it: ${message(failure)}`),
                      )
                    }
                    title={
                      on && blocks > 0
                        ? `Its ${blocks} block${blocks === 1 ? "" : "s"} leave the routine`
                        : undefined
                    }
                  >
                    {on ? "Turn off" : "Turn on"}
                  </button>
                </span>
              </EventCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Each active area's routine hours against its weekly target, on a dark panel. */
function AreaTargets({
  rows,
  areas,
  onOpen,
}: {
  rows: RoutineRow[];
  areas: AreaRow[];
  onOpen: () => void;
}) {
  const active = areas.filter((area) => area.active === 1);
  const total = rows.reduce((sum, row) => sum + row.duration_min, 0);
  return (
    <section className="panel rt-targets" aria-labelledby="rt-targets">
      <PanelHead
        id="rt-targets"
        title="Area targets"
        sub="Hours in the routine against each weekly target"
        action={
          <button type="button" className="icon-btn" aria-label="Change areas" onClick={onOpen}>
            <IconArrowUpRight size={18} />
          </button>
        }
      />
      {active.length === 0 ? (
        <p className="empty">No areas on. Add one under Areas.</p>
      ) : (
        <ul className="rt-target-list">
          {active.map((area) => {
            const planned = rows
              .filter((row) => row.area_id === area.id)
              .reduce((sum, row) => sum + row.duration_min, 0);
            const target = area.weekly_target_min;
            return (
              <li key={area.id}>
                <div className="rt-target-line">
                  <span
                    className="rt-dot"
                    style={{ background: `var(--area-${area.color})` }}
                    aria-hidden="true"
                  />
                  <span className="grow">{area.name}</span>
                  <span className="rt-target-num">
                    {hours(planned)}
                    <span className="soft"> / {hours(target)} h</span>
                  </span>
                </div>
                <Bar
                  value={target > 0 ? planned / target : 0}
                  area={area.color as AreaColor}
                  label={`${area.name}: ${hours(planned)} of ${hours(target)} hours in the routine`}
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint rt-target-foot">
        {hours(total)} h of blocks a week. Grow and Admin areas also fill free slots.
      </p>
    </section>
  );
}

const TIMES_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN ('day.wake', 'day.review', 'day.hard_stop')`;

function TimesPanel() {
  const rows = useLiveQuery<{ key: string; value_json: string }>(TIMES_SQL);
  const [note, setNote] = useState("");
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
    <section className="panel rt-times" aria-label="Day times">
      <PanelHead
        icon={<IconClock size={18} />}
        title="Day times"
        sub={<span role="status">{note || "When your day starts, is reviewed and must end"}</span>}
      />
      {!rows.loading && (
        <div className="rt-time-grid">
          {fields.map(([key, label, value]) => (
            <label key={key} className="field rt-time">
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
        </div>
      )}
    </section>
  );
}

function StartOver({ onStartOver }: { onStartOver: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <section className="panel rt-start-over" aria-labelledby="rt-start-over">
      <PanelHead
        id="rt-start-over"
        title="Start over"
        sub="Want a fresh routine from a few questions instead?"
      />
      {sure ? (
        <>
          <p className="meta">
            Saving those answers replaces your whole routine (areas you added stay).
          </p>
          <div className="rt-actions">
            <Button onClick={onStartOver}>Show the questions</Button>
            <Button className="btn-ghost" onClick={() => setSure(false)}>
              Keep my routine
            </Button>
          </div>
        </>
      ) : (
        <Button onClick={() => setSure(true)}>Start over</Button>
      )}
    </section>
  );
}

/** My week (plan §3.2): the routine, the areas and the day's times, all editable. */
export function Week({ onStartOver }: { onStartOver: () => void }) {
  const rows = useLiveQuery<RoutineRow & Record<string, string | number | null>>(ROUTINE_SQL);
  const areas = useLiveQuery<AreaRow & Record<string, string | number | null>>(AREAS_SQL);
  const [tab, setTab] = useState<"routine" | "areas">("routine");
  const [blockForm, setBlockForm] = useState<BlockFormState | null>(null);
  const [areaForm, setAreaForm] = useState<{ editing: AreaRow | null } | null>(null);
  const today = isoWeekday(logicalDate(systemClock.now())) as Weekday;
  const loaded = !rows.loading && !areas.loading;
  const total = rows.rows.reduce((sum, row) => sum + row.duration_min, 0);
  return (
    <main className="page week plan-routine">
      <div className="layout-split">
        <aside className="side" aria-label="Targets and times">
          {loaded && (
            <AreaTargets rows={rows.rows} areas={areas.rows} onOpen={() => setTab("areas")} />
          )}
          <TimesPanel />
          <StartOver onStartOver={onStartOver} />
        </aside>

        <div className="main">
          <section className="canvas rt-canvas" aria-labelledby="week-title">
            <header className="canvas-head">
              <h1 id="week-title" className="page-title">
                My week
                {loaded && (
                  <span className="soft">
                    , {rows.rows.length} blocks · {hours(total)} h
                  </span>
                )}
              </h1>
              <Segmented
                label="Part"
                options={[
                  { value: "routine", label: "Routine" },
                  { value: "areas", label: "Areas" },
                ]}
                value={tab}
                onChange={setTab}
              />
              <span className="spacer" />
              {tab === "routine" ? (
                <Button primary onClick={() => setBlockForm(newBlock(today))}>
                  <IconPlus size={16} /> Add a block
                </Button>
              ) : (
                <Button primary onClick={() => setAreaForm({ editing: null })}>
                  <IconPlus size={16} /> Add an area
                </Button>
              )}
            </header>
            <p className="meta rt-lead">
              Your routine repeats every week. Changes apply from today: Sirna plans today again.
            </p>
            {(rows.error ?? areas.error) && (
              <p role="alert" className="error">
                Couldn&apos;t load your week: {rows.error ?? areas.error}
              </p>
            )}
            {loaded && tab === "routine" && (
              <RoutineTab
                rows={rows.rows}
                areas={areas.rows}
                today={today}
                form={blockForm}
                setForm={setBlockForm}
              />
            )}
            {loaded && tab === "areas" && (
              <AreasTab rows={rows.rows} areas={areas.rows} form={areaForm} setForm={setAreaForm} />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
