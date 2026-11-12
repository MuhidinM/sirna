import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { type ClockStyle } from "../capture/when";
import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  DEFAULT_ANSWERS,
  type JobAnswer,
  parseTimes,
  type Weekday,
} from "../features/plan/routine";
import { setupOps, type SetupChoices } from "../features/plan/setup";
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
    <fieldset className="days">
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
  const [jobs, setJobs] = useState<(JobAnswer & { enabled: boolean })[]>(
    DEFAULT_ANSWERS.jobs.map((job) => ({ ...job, enabled: true })),
  );
  const [areas, setAreas] = useState(() =>
    Object.fromEntries(AREAS.map((area) => [area.id, { on: true, hours: area.hours }])),
  );
  const [gymDays, setGymDays] = useState<Weekday[]>(DEFAULT_ANSWERS.gymDays);
  const [gymTime, setGymTime] = useState(DEFAULT_ANSWERS.gymTime);
  const [emailText, setEmailText] = useState(DEFAULT_ANSWERS.emailChecks.join(", "));
  const [restDay, setRestDay] = useState<Weekday>(DEFAULT_ANSWERS.restDay);
  const [clockStyle, setClockStyle] = useState<ClockStyle>("western");
  const [startWithWindows, setStartWithWindows] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // Running setup again starts from what you chose last time.
  useEffect(() => {
    void Promise.all([
      query<{ key: string; value_json: string }>(
        "SELECT key, value_json FROM core_settings WHERE key IN ('day.wake', 'day.hard_stop', 'day.review', 'capture.clock_style', 'setup.answers')",
      ),
      query<{ id: string; name: string; weekly_target_min: number; active: number }>(
        "SELECT id, name, weekly_target_min, active FROM area_items WHERE deleted_at IS NULL",
      ),
      invoke<boolean>("autostart_status").catch(() => true),
    ]).then(([settings, savedAreas, autostart]) => {
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
      const answers = value("setup.answers") as Partial<SetupChoices> | undefined;
      if (!answers) return; // first run: keep the defaults
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
        setJobs(
          answers.jobs.map((job) => ({
            ...job,
            name: nameOf.get(job.areaId) ?? job.name,
            enabled: activeIds.has(job.areaId),
          })),
        );
      }
      if (answers.gymDays) setGymDays(answers.gymDays);
      if (answers.gymTime) setGymTime(answers.gymTime);
      if (answers.emailChecks) setEmailText(answers.emailChecks.join(", "));
      if (answers.restDay) setRestDay(answers.restDay);
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
  }, []);

  const updateJob = (index: number, change: Partial<JobAnswer & { enabled: boolean }>) =>
    setJobs((current) => current.map((job, i) => (i === index ? { ...job, ...change } : job)));

  async function save() {
    const emailChecks = parseTimes(emailText);
    if (!emailChecks) {
      setError('Email check times: use times like "10:00, 15:00", or leave it empty for none.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const activeAreas = [
        ...jobs.filter((job) => job.enabled).map((job) => job.areaId),
        ...Object.entries(areas)
          .filter(([, area]) => area.on)
          .map(([id]) => id),
      ];
      const choices: SetupChoices = {
        wake,
        hardStop,
        review,
        jobs: jobs.map(({ enabled: _enabled, ...job }) => job),
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
      // Only the areas these questions ask about; ones added in My week stay as they are.
      const managed = new Set([...jobs.map((job) => job.areaId), ...AREAS.map((area) => area.id)]);
      const allAreas = (
        await query<{ id: string }>("SELECT id FROM area_items WHERE deleted_at IS NULL")
      ).filter((area) => managed.has(area.id));
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

  return (
    <main className="setup">
      <h1>Set up your week</h1>
      <p className="meta">About 5 minutes. You can change all of this later.</p>

      <section aria-labelledby="day">
        <h2 id="day">Your day</h2>
        <div className="row">
          <label>
            Wake <input type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
          </label>
          <label>
            Night review{" "}
            <input type="time" value={review} onChange={(e) => setReview(e.target.value)} />
          </label>
          <label>
            Hard stop{" "}
            <input type="time" value={hardStop} onChange={(e) => setHardStop(e.target.value)} />
          </label>
        </div>
      </section>

      <section aria-labelledby="jobs">
        <h2 id="jobs">Your jobs</h2>
        {jobs.map((job, index) => (
          <div className="card job" key={job.areaId}>
            <label>
              <input
                type="checkbox"
                checked={job.enabled}
                onChange={(e) => updateJob(index, { enabled: e.target.checked })}
              />
              <input
                aria-label="Job name"
                value={job.name}
                onChange={(e) => updateJob(index, { name: e.target.value })}
              />
            </label>
            <DayPicker
              value={job.days}
              onChange={(days) => updateJob(index, { days })}
              label={`${job.name} days`}
            />
            <div className="row">
              <label>
                From{" "}
                <input
                  type="time"
                  value={job.start}
                  onChange={(e) => updateJob(index, { start: e.target.value })}
                />
              </label>
              <label>
                To{" "}
                <input
                  type="time"
                  value={job.end}
                  onChange={(e) => updateJob(index, { end: e.target.value })}
                />
              </label>
            </div>
          </div>
        ))}
      </section>

      <section aria-labelledby="areas">
        <h2 id="areas">What else gets your time each week</h2>
        <ul className="areas">
          {AREAS.map((area) => {
            const state = areas[area.id] ?? { on: true, hours: area.hours };
            return (
              <li key={area.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={state.on}
                    onChange={(e) =>
                      setAreas({ ...areas, [area.id]: { ...state, on: e.target.checked } })
                    }
                  />
                  {area.name}
                </label>
                <label className="hours">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={state.hours}
                    aria-label={`${area.name} hours a week`}
                    onChange={(e) =>
                      setAreas({ ...areas, [area.id]: { ...state, hours: Number(e.target.value) } })
                    }
                  />
                  h / week
                </label>
                {area.note && <span className="meta">{area.note}</span>}
              </li>
            );
          })}
        </ul>
        <div className="row">
          <span>Gym days</span>
          <DayPicker value={gymDays} onChange={setGymDays} label="Gym days" />
          <label>
            at <input type="time" value={gymTime} onChange={(e) => setGymTime(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label>
            Check email at{" "}
            <input
              value={emailText}
              aria-label="Email check times"
              placeholder="10:00, 15:00"
              onChange={(e) => setEmailText(e.target.value)}
            />
          </label>
          <span className="meta">10-minute reminders on workdays; leave empty for none</span>
        </div>
        <div className="row">
          <label>
            Rest day{" "}
            <select value={restDay} onChange={(e) => setRestDay(Number(e.target.value) as Weekday)}>
              {DAYS.map(([day, name]) => (
                <option key={day} value={day}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section aria-labelledby="small">
        <h2 id="small">Two small things</h2>
        <fieldset className="row">
          <legend>When you write &ldquo;at 3&rdquo;, you mean</legend>
          <label>
            <input
              type="radio"
              checked={clockStyle === "western"}
              onChange={() => setClockStyle("western")}
            />{" "}
            15:00
          </label>
          <label>
            <input
              type="radio"
              checked={clockStyle === "ethiopian"}
              onChange={() => setClockStyle("ethiopian")}
            />{" "}
            09:00 (Ethiopian clock)
          </label>
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={startWithWindows}
            onChange={(e) => setStartWithWindows(e.target.checked)}
          />{" "}
          Start Sirna with Windows (it waits in the tray)
        </label>
      </section>

      {error && (
        <p role="alert" className="error">
          Couldn&apos;t save: {error}
        </p>
      )}
      <p>
        <Button primary disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Start my week"}
        </Button>
      </p>
    </main>
  );
}
