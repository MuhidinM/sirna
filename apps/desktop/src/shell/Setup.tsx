import "../theme/pages/plan-routine.css";

import { invoke } from "@tauri-apps/api/core";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { type ClockStyle } from "../capture/when";
import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  DEFAULT_ANSWERS,
  type FixedRow,
  type JobAnswer,
  jobParts,
  jobProblems,
  jobsFromMyWeek,
  nextPart,
  parseTimes,
  type SavedJob,
  type TimeRange,
  type Weekday,
} from "../features/plan/routine";
import { newJob, setupOps, type SetupChoices } from "../features/plan/setup";
import { IconArrowLeft, IconArrowRight, IconCheck, IconPlus } from "./icons";
import { Button } from "./ui";

const DAYS: [Weekday, string][] = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

const AREAS: { id: string; name: string; hours: number; note?: string }[] = [
  { id: "jobhunt", name: "Job hunt", hours: 4 },
  { id: "coding", name: "Coding skills", hours: 4 },
  { id: "experiments", name: "Experiments", hours: 3, note: "capped: never more than this" },
  { id: "gym", name: "Gym", hours: 2.25, note: "protected" },
  { id: "quran", name: "Quran", hours: 2.3, note: "protected, 20 min a day" },
  { id: "admin", name: "Life admin", hours: 2.3, note: "email checks, errands" },
];

const STEPS = ["Your day", "Your jobs", "Your week", "Two small things"];

/**
 * A job row on the form. A removed saved job stays here, hidden, so it switches
 * off. `hoursDiffer`: a My-week job whose days have different hours.
 */
type JobRow = JobAnswer & { enabled: boolean; removed?: boolean; hoursDiffer?: boolean };

function DayPicker({
  value,
  onChange,
  label,
}: {
  value: Weekday[];
  onChange: (days: Weekday[]) => void;
  label: string;
}) {
  return (
    <fieldset className="days rt-days">
      <legend className="visually-hidden">{label}</legend>
      {DAYS.map(([day, name]) => (
        <label key={day} className={value.includes(day) ? "day on" : "day"}>
          <input
            type="checkbox"
            checked={value.includes(day)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...value, day].sort() : value.filter((d) => d !== day),
              )
            }
          />
          {name}
        </label>
      ))}
    </fieldset>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [wake, setWake] = useState(DEFAULT_ANSWERS.wake);
  const [hardStop, setHardStop] = useState(DEFAULT_ANSWERS.hardStop);
  const [review, setReview] = useState(DEFAULT_ANSWERS.review);
  const [jobs, setJobs] = useState<JobRow[]>(
    DEFAULT_ANSWERS.jobs.map((job) => ({ ...job, enabled: true })),
  );
  // Every area id ever used (deleted ones too), and the ones saved now.
  const [takenIds, setTakenIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [areas, setAreas] = useState(() =>
    Object.fromEntries(AREAS.map((area) => [area.id, { on: true, hours: area.hours }])),
  );
  const [gymDays, setGymDays] = useState<Weekday[]>(DEFAULT_ANSWERS.gymDays);
  const [gymTime, setGymTime] = useState(DEFAULT_ANSWERS.gymTime);
  const [emailText, setEmailText] = useState(DEFAULT_ANSWERS.emailChecks.join(", "));
  const [lunch, setLunch] = useState("");
  const [restDay, setRestDay] = useState<Weekday>(DEFAULT_ANSWERS.restDay);
  const [clockStyle, setClockStyle] = useState<ClockStyle>("western");
  const [startWithWindows, setStartWithWindows] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);
  // After a remove, the button that had focus is gone: the first of these that exists gets it.
  const focusNext = useRef<string[]>(undefined);

  useEffect(() => {
    const selectors = focusNext.current;
    if (!selectors) return;
    focusNext.current = undefined;
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus();
        break;
      }
    }
  }, [jobs]);

  // Running setup again starts from what you chose last time.
  useEffect(() => {
    // StrictMode runs this twice in dev; only the last run may set state.
    let cancelled = false;
    void Promise.all([
      query<{ key: string; value_json: string }>(
        "SELECT key, value_json FROM core_settings WHERE key IN ('day.wake', 'day.hard_stop', 'day.review', 'capture.clock_style', 'setup.answers')",
      ),
      query<{
        id: string;
        name: string;
        kind: string;
        weekly_target_min: number;
        active: number;
        deleted_at: number | null;
      }>("SELECT id, name, kind, weekly_target_min, active, deleted_at FROM area_items"),
      query<FixedRow & { area_id: string }>(
        "SELECT area_id, weekday, start_min, duration_min FROM routine_blocks WHERE deleted_at IS NULL AND kind = 'fixed' AND area_id IS NOT NULL",
      ),
      invoke<boolean>("autostart_status").catch(() => true),
    ]).then(([settings, areaRows, fixedRows, autostart]) => {
      if (cancelled) return;
      const savedAreas = areaRows.filter((area) => area.deleted_at === null);
      setTakenIds(areaRows.map((area) => area.id));
      setSavedIds(savedAreas.map((area) => area.id));
      const value = (key: string): unknown => {
        const row = settings.find((setting) => setting.key === key);
        try {
          return row ? (JSON.parse(row.value_json) as unknown) : undefined;
        } catch {
          return undefined;
        }
      };
      const text = (key: string) =>
        typeof value(key) === "string" ? (value(key) as string) : undefined;
      const answers = value("setup.answers") as
        (Partial<Omit<SetupChoices, "jobs">> & { jobs?: SavedJob[] }) | undefined;
      // Jobs added in My week with set hours join the list, so setup rebuilds their blocks too.
      const defaultJobs: JobRow[] = DEFAULT_ANSWERS.jobs.map((job) => ({ ...job, enabled: true }));
      const weekJobs: JobRow[] = jobsFromMyWeek(
        savedAreas,
        fixedRows,
        (answers?.jobs ?? DEFAULT_ANSWERS.jobs).map((job) => job.areaId),
      ).map((job) => ({ ...job, enabled: true }));
      if (!answers) {
        // First run: keep the defaults.
        setJobs([...defaultJobs, ...weekJobs]);
        return;
      }
      setWake(text("day.wake") ?? DEFAULT_ANSWERS.wake);
      setHardStop(text("day.hard_stop") ?? DEFAULT_ANSWERS.hardStop);
      setReview(text("day.review") ?? DEFAULT_ANSWERS.review);
      if (text("capture.clock_style") === "ethiopian") setClockStyle("ethiopian");
      if (answers.jobs) {
        const activeIds = new Set(
          savedAreas.filter((area) => area.active === 1).map((area) => area.id),
        );
        // Names as they are now (My week can rename a job), not as first answered.
        const nameOf = new Map(savedAreas.map((area) => [area.id, area.name]));
        setJobs([
          // Saves from before job parts hold one start and end: that is one part.
          ...answers.jobs.map((saved) => ({
            areaId: saved.areaId,
            name: nameOf.get(saved.areaId) ?? saved.name,
            days: saved.days,
            parts: jobParts(saved),
            enabled: activeIds.has(saved.areaId),
          })),
          ...weekJobs,
        ]);
      } else setJobs([...defaultJobs, ...weekJobs]);
      if (answers.gymDays) setGymDays(answers.gymDays);
      if (answers.gymTime) setGymTime(answers.gymTime);
      if (answers.emailChecks) setEmailText(answers.emailChecks.join(", "));
      if (answers.restDay) setRestDay(answers.restDay);
      if (answers.lunch) setLunch(answers.lunch);
      setAreas(
        Object.fromEntries(
          AREAS.map((area) => {
            const saved = savedAreas.find((row) => row.id === area.id);
            return [
              area.id,
              saved
                ? { on: saved.active === 1, hours: saved.weekly_target_min / 60 }
                : { on: true, hours: area.hours },
            ];
          }),
        ),
      );
      setStartWithWindows(autostart);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateJob = (index: number, change: Partial<JobRow>) =>
    setJobs((current) => current.map((job, i) => (i === index ? { ...job, ...change } : job)));

  const addJob = () =>
    setJobs((current) => [
      ...current,
      {
        ...newJob(
          [...takenIds, ...current.map((job) => job.areaId)],
          current.filter((job) => !job.removed).map((job) => job.name),
        ),
        enabled: true,
      },
    ]);

  // A saved job only switches off: its history, pay and tasks stay.
  const removeJob = (index: number) => {
    // Focus moves to the next job's name, else the one before, else "Add a job".
    const after = jobs.slice(index + 1).find((job) => !job.removed);
    const before = jobs
      .slice(0, index)
      .reverse()
      .find((job) => !job.removed);
    focusNext.current = [
      ...[after, before].flatMap((job) => (job ? [`[data-job-name="${job.areaId}"]`] : [])),
      "[data-add-job]",
    ];
    setJobs((current) =>
      savedIds.includes(current[index]?.areaId ?? "")
        ? current.map((job, i) => (i === index ? { ...job, enabled: false, removed: true } : job))
        : current.filter((_, i) => i !== index),
    );
  };

  const updatePart = (index: number, part: number, change: Partial<TimeRange>) =>
    setJobs((current) =>
      current.map((job, i) =>
        i === index
          ? { ...job, parts: job.parts.map((p, n) => (n === part ? { ...p, ...change } : p)) }
          : job,
      ),
    );

  const addPart = (index: number) =>
    setJobs((current) =>
      current.map((job, i) => {
        const part = i === index ? nextPart(job.parts) : null;
        return part ? { ...job, parts: [...job.parts, part] } : job;
      }),
    );

  const removePart = (index: number, part: number) => {
    const id = jobs[index]?.areaId ?? "";
    // Focus moves to "+ Part", or to the job's name when no part fits.
    focusNext.current = [`[data-part-add="${id}"]`, `[data-job-name="${id}"]`];
    setJobs((current) =>
      current.map((job, i) =>
        i === index ? { ...job, parts: job.parts.filter((_, n) => n !== part) } : job,
      ),
    );
  };

  const shownJobs = jobs.filter((job) => !job.removed);

  async function save() {
    const problem = jobProblems(shownJobs, lunch);
    if (problem) {
      setError(problem);
      setStep(1);
      return;
    }
    const emailChecks = parseTimes(emailText);
    if (!emailChecks) {
      setError('Email check times: use times like "10:00, 15:00", or leave it empty for none.');
      setStep(2);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const activeAreas = [
        ...shownJobs.filter((job) => job.enabled).map((job) => job.areaId),
        ...Object.entries(areas)
          .filter(([, area]) => area.on)
          .map(([id]) => id),
      ];
      const choices: SetupChoices = {
        wake,
        hardStop,
        review,
        // Parts only: the old single start and end are not written again.
        jobs: shownJobs.map(({ areaId, name, days, parts }) => ({
          areaId,
          name: name.trim(),
          days,
          parts,
        })),
        lunch,
        activeAreas,
        restDay,
        gymDays,
        gymTime,
        emailChecks,
        clockStyle,
        targetsHours: Object.fromEntries(
          Object.entries(areas).map(([id, area]) => [id, area.hours]),
        ),
      };
      const existing = await query<{ id: string }>(
        "SELECT id FROM routine_blocks WHERE deleted_at IS NULL",
      );
      // Only the areas these questions ask about (removed jobs too, so they switch off);
      // other areas added in My week stay as they are.
      const managed = new Set([...jobs.map((job) => job.areaId), ...AREAS.map((area) => area.id)]);
      const areaRows = await query<{ id: string; deleted_at: number | null }>(
        "SELECT id, deleted_at FROM area_items",
      );
      const allAreas = areaRows.filter((area) => area.deleted_at === null && managed.has(area.id));
      // Today's generated blocks follow the old routine; drop them so Today replans.
      const today = logicalDate(systemClock.now());
      const generated = await query<{ id: string }>(
        "SELECT id FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL AND source IN ('template', 'generator') AND user_edited_at IS NULL",
        [today],
      );
      await transact(
        "user",
        [
          ...setupOps(
            choices,
            existing.map((row) => row.id),
            allAreas.map((row) => row.id),
            () => ulid(),
            areaRows.map((row) => row.id),
          ),
          ...generated.map((row) => ({
            op: "delete" as const,
            table: "day_blocks" as const,
            id: row.id,
          })),
        ],
        "setup",
      );
      await invoke("autostart_set", { enabled: startWithWindows });
      onDone();
    } catch (problem) {
      setError(String(problem));
      setSaving(false);
    }
  }

  const last = STEPS.length - 1;

  // Enter in a field takes the primary button: Next, or save on the last step.
  function submit(event: FormEvent) {
    event.preventDefault();
    if (step < last) setStep(step + 1);
    else if (!saving) void save();
  }

  return (
    <main className="setup su-page">
      <form className="canvas su-canvas" aria-labelledby="su-title" onSubmit={submit}>
        <header className="su-head">
          <h1 id="su-title" className="page-title">
            Set up <span className="soft">your week</span>
          </h1>
          <p className="meta">About 5 minutes. You can change all of this later.</p>
        </header>

        <ol className="su-steps" aria-label="Steps">
          {STEPS.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                className={
                  index === step ? "su-step current" : index < step ? "su-step done" : "su-step"
                }
                aria-current={index === step ? "step" : undefined}
                onClick={() => setStep(index)}
              >
                <span className="su-step-n" aria-hidden="true">
                  {index < step ? <IconCheck size={14} /> : index + 1}
                </span>
                {name}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section aria-labelledby="day" className="su-section">
            <h2 id="day">Your day</h2>
            <p className="meta">
              When you get up, when you look back at the day, and when work stops.
            </p>
            <div className="su-times">
              <label className="su-time">
                <span>Wake</span>
                <input type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
              </label>
              <label className="su-time">
                <span>Night review</span>
                <input type="time" value={review} onChange={(e) => setReview(e.target.value)} />
              </label>
              <label className="su-time">
                <span>Hard stop</span>
                <input type="time" value={hardStop} onChange={(e) => setHardStop(e.target.value)} />
              </label>
            </div>
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="jobs" className="su-section">
            <h2 id="jobs">Your jobs</h2>
            <p className="meta">
              Untick a job you don&apos;t have this week, or remove it. Sirna plans around these
              hours.
            </p>
            <div className="su-jobs">
              {jobs.map((job, index) =>
                job.removed ? null : (
                  <div
                    className={job.enabled ? "card job su-job" : "card job su-job off"}
                    key={job.areaId}
                  >
                    <div className="su-job-head">
                      <label className="su-job-name">
                        <input
                          type="checkbox"
                          checked={job.enabled}
                          onChange={(e) => updateJob(index, { enabled: e.target.checked })}
                        />
                        <input
                          aria-label="Job name"
                          data-job-name={job.areaId}
                          value={job.name}
                          onChange={(e) => updateJob(index, { name: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="link-btn su-remove"
                        aria-label={`Remove ${job.name || "this job"}`}
                        onClick={() => removeJob(index)}
                      >
                        Remove
                      </button>
                    </div>
                    <DayPicker
                      value={job.days}
                      onChange={(days) => updateJob(index, { days })}
                      label={`${job.name} days`}
                    />
                    {job.hoursDiffer && (
                      <p className="meta su-job-note">
                        Hours differ by day in My week. Saving uses these hours on every day.
                      </p>
                    )}
                    {job.parts.map((part, n) => (
                      <div className="su-pair su-part" key={n}>
                        <label className="su-field">
                          <span>From</span>
                          <input
                            type="time"
                            value={part.start}
                            onChange={(e) => updatePart(index, n, { start: e.target.value })}
                          />
                        </label>
                        <label className="su-field">
                          <span>To</span>
                          <input
                            type="time"
                            value={part.end}
                            onChange={(e) => updatePart(index, n, { end: e.target.value })}
                          />
                        </label>
                        {n > 0 ? (
                          <button
                            type="button"
                            className="icon-btn plain su-part-x"
                            aria-label={`Remove part ${n + 1} of ${job.name}`}
                            onClick={() => removePart(index, n)}
                          >
                            ×
                          </button>
                        ) : (
                          <span aria-hidden="true" />
                        )}
                      </div>
                    ))}
                    {nextPart(job.parts) && (
                      <button
                        type="button"
                        className="link-btn su-part-add"
                        data-part-add={job.areaId}
                        onClick={() => addPart(index)}
                      >
                        + Part
                      </button>
                    )}
                  </div>
                ),
              )}
            </div>
            <p className="meta su-hint">
              Leave lunch out: add a second part after it. Hours inside parts count as work.
            </p>
            <Button className="su-add" data-add-job onClick={addJob}>
              <IconPlus size={16} /> Add a job
            </Button>
            <div className="card su-extra su-lunch">
              <label className="su-field">
                <span className="su-extra-title">Lunch time</span>
                <input
                  type="time"
                  value={lunch}
                  aria-describedby="su-lunch-note"
                  onChange={(e) => setLunch(e.target.value)}
                />
              </label>
              <span className="meta" id="su-lunch-note">
                1 hour on workdays; leave empty for none. Without it, a focus block may be planned
                in the gap between parts.
              </span>
            </div>
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="areas" className="su-section">
            <h2 id="areas">What else gets your time each week</h2>
            <ul className="areas su-areas">
              {AREAS.map((area) => {
                const state = areas[area.id] ?? { on: true, hours: area.hours };
                return (
                  <li key={area.id} className={state.on ? "su-area" : "su-area off"}>
                    <label className="su-area-name">
                      <input
                        type="checkbox"
                        checked={state.on}
                        onChange={(e) =>
                          setAreas({ ...areas, [area.id]: { ...state, on: e.target.checked } })
                        }
                      />
                      <span>
                        {area.name}
                        {area.note && <span className="meta su-note">{area.note}</span>}
                      </span>
                    </label>
                    <label className="hours su-hours">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={state.hours}
                        aria-label={`${area.name} hours a week`}
                        onChange={(e) =>
                          setAreas({
                            ...areas,
                            [area.id]: { ...state, hours: Number(e.target.value) },
                          })
                        }
                      />
                      h / week
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="su-extras">
              <div className="card su-extra">
                <span className="su-extra-title">Gym days</span>
                <DayPicker value={gymDays} onChange={setGymDays} label="Gym days" />
                <label className="su-field">
                  <span>At</span>
                  <input type="time" value={gymTime} onChange={(e) => setGymTime(e.target.value)} />
                </label>
              </div>
              <div className="card su-extra">
                <label className="su-field">
                  <span className="su-extra-title">Check email at</span>
                  <input
                    value={emailText}
                    aria-label="Email check times"
                    placeholder="10:00, 15:00"
                    onChange={(e) => setEmailText(e.target.value)}
                  />
                </label>
                <span className="meta">10-minute reminders on workdays; leave empty for none</span>
              </div>
              <div className="card su-extra">
                <label className="su-field">
                  <span className="su-extra-title">Rest day</span>
                  <select
                    value={restDay}
                    onChange={(e) => setRestDay(Number(e.target.value) as Weekday)}
                  >
                    {DAYS.map(([day, name]) => (
                      <option key={day} value={day}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby="small" className="su-section">
            <h2 id="small">Two small things</h2>
            <fieldset className="su-choice">
              <legend>When you write &ldquo;at 3&rdquo;, you mean</legend>
              <label className={clockStyle === "western" ? "su-tile on" : "su-tile"}>
                <input
                  type="radio"
                  checked={clockStyle === "western"}
                  onChange={() => setClockStyle("western")}
                />
                <span className="su-tile-big">15:00</span>
              </label>
              <label className={clockStyle === "ethiopian" ? "su-tile on" : "su-tile"}>
                <input
                  type="radio"
                  checked={clockStyle === "ethiopian"}
                  onChange={() => setClockStyle("ethiopian")}
                />
                <span className="su-tile-big">09:00</span>
                <span className="meta">Ethiopian clock</span>
              </label>
            </fieldset>
            <label className={startWithWindows ? "su-tile su-wide on" : "su-tile su-wide"}>
              <input
                type="checkbox"
                checked={startWithWindows}
                onChange={(e) => setStartWithWindows(e.target.checked)}
              />
              Start Sirna with Windows (it waits in the tray)
            </label>
          </section>
        )}

        {error && (
          <p role="alert" className="error">
            Couldn&apos;t save: {error}
          </p>
        )}

        <footer className="su-foot">
          {/* Stays in place on the first step, so focus never drops to the page. */}
          <Button
            className="su-back"
            aria-disabled={step === 0}
            onClick={() => {
              if (step > 0) setStep(step - 1);
            }}
          >
            <IconArrowLeft size={16} /> Back
          </Button>
          <span className="su-count meta">
            Step {step + 1} of {STEPS.length}
          </span>
          {step < last ? (
            <Button primary type="submit">
              Next <IconArrowRight size={16} />
            </Button>
          ) : (
            <Button primary type="submit" disabled={saving}>
              {saving ? "Saving…" : "Start my week"}
            </Button>
          )}
        </footer>
      </form>
    </main>
  );
}
