import "../theme/pages/settings.css";

import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { type Op, transact } from "../kernel/db";
import { CHEATS_SQL, WIDGET_ENABLED_KEY, WIDGET_NOTE_KEY, WIDGET_SQL } from "../widget/view";
import {
  checkCap,
  cleanSecret,
  readSettings,
  SECRETS,
  SETTINGS_SQL,
  settingsOps,
  type SettingsValues,
} from "../features/settings/settings";
import { THEMES } from "../theme/theme";
import { transactTheme, useTheme } from "./useTheme";
import { AI_LOG_SQL, type AiCall, callSummary, checkDailyCap, pretty } from "../features/ai/log";
import { systemClock } from "../kernel/clock";
import { CalendarStatus, syncNow } from "./Calendar";
import { IconArrowRight, IconBolt, IconExpand, IconPencil, IconSettings, IconSun } from "./icons";
import { PanelHead } from "./kit";
import { Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";
import { pageOf } from "./paging";
import { AI_CHANGED_EVENT, BACKUP_LAST_SQL, statusLines } from "../features/settings/status";
import { SYNC_SQL } from "../features/calendar/sync";
import { logicalDate } from "../kernel/dates";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One secret: shows only whether it is saved. The value goes straight to
 * Windows Credential Manager and is never read back into the window.
 */
function SecretField({ name, label, help, placeholder }: (typeof SECRETS)[number]) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(
    () =>
      invoke<boolean>("secret_status", { name })
        .then(setSaved)
        .catch((error: unknown) => setNote(`Couldn't check: ${message(error)}`)),
    [name],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const store = (value: string, done: string) =>
    invoke("secret_set", { name, value })
      .then(() => {
        setText("");
        setNote(done);
        // A new calendar address is tried at once, so the status says if it works.
        if (name === "ical_url") void syncNow();
        window.dispatchEvent(new Event(AI_CHANGED_EVENT));
        return refresh();
      })
      .catch((error: unknown) => setNote(`Couldn't save: ${message(error)}`));

  const status = saved === null ? "" : saved ? "Saved in Windows Credential Manager" : "Not set";
  return (
    <form
      className="setting"
      onSubmit={(event) => {
        event.preventDefault();
        const value = cleanSecret(text);
        if (value) void store(value, saved ? "Replaced" : "Saved");
      }}
    >
      <label className="field">
        <span>{label}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={saved ? "Saved · paste a new one to replace it" : placeholder}
          onChange={(event) => {
            setNote("");
            setText(event.target.value);
          }}
        />
      </label>
      <p className="meta">{help}</p>
      <div className="row">
        <Button type="submit" disabled={!cleanSecret(text)}>
          {saved ? "Replace" : "Save"}
        </Button>
        {saved && (
          <Button className="btn-ghost btn-danger" onClick={() => void store("", "Removed")}>
            Remove
          </Button>
        )}
        <span className={saved && !note ? "set-state saved" : "set-state"} role="status">
          {note || status}
        </span>
      </div>
    </form>
  );
}

function CaptureKey() {
  const [current, setCurrent] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    invoke<string | null>("hotkey_current")
      .then(setCurrent)
      .catch(() => setCurrent(null));
  }, []);
  const apply = (key: string) =>
    invoke<string>("hotkey_set", { key })
      .then((inUse) => {
        setCurrent(inUse);
        setText("");
        setNote(key ? "Saved · works now" : `Back to the default: ${inUse}`);
      })
      .catch((error: unknown) => setNote(message(error)));
  return (
    <form
      className="setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) void apply(text.trim());
      }}
    >
      <label className="field">
        <span>Capture key{current ? ` (in use: ${current})` : ""}</span>
        <input
          value={text}
          placeholder="e.g. Ctrl+Alt+K"
          onChange={(event) => {
            setNote("");
            setText(event.target.value);
          }}
        />
      </label>
      <div className="row">
        <Button type="submit" disabled={!text.trim()}>
          Use this key
        </Button>
        <Button onClick={() => void apply("")}>Back to default</Button>
        <span className="meta set-note" role="status">
          {note}
        </span>
      </div>
    </form>
  );
}

function FocusAndLook({ initial }: { initial: SettingsValues }) {
  const [values, setValues] = useState(initial);
  const [capText, setCapText] = useState(String(initial.capMin));
  const [note, setNote] = useState("");
  // The theme on screen, wherever it was changed (here or on the rail).
  const current = useTheme();
  const change = (next: SettingsValues) => {
    setNote("");
    setValues(next);
  };
  return (
    <form
      className="setting"
      onSubmit={(event) => {
        event.preventDefault();
        const cap = checkCap(capText);
        if ("error" in cap) {
          setNote(cap.error);
          return;
        }
        const next = { ...values, capMin: cap.minutes, theme: current };
        transact("user", settingsOps(next), "settings")
          .then(() => setNote("Saved"))
          .catch((error: unknown) => setNote(`Couldn't save: ${message(error)}`));
      }}
    >
      <label className="field">
        <span>Focus cap per day (minutes)</span>
        <input
          inputMode="numeric"
          value={capText}
          onChange={(event) => {
            setNote("");
            setCapText(event.target.value);
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={values.dnd}
          onChange={(event) => change({ ...values, dnd: event.target.checked })}
        />
        Turn on Do not disturb during focus
      </label>
      <fieldset className="field set-theme">
        <legend>Theme</legend>
        <div className="seg">
          {THEMES.map(({ theme, label }) => (
            <label key={theme} className={`seg-item set-theme-${theme}`}>
              <input
                type="radio"
                name="theme"
                className="visually-hidden"
                value={theme}
                checked={current === theme}
                onChange={() =>
                  void transactTheme(theme)
                    .then(() => setNote(""))
                    .catch((error: unknown) => setNote(`Couldn't save: ${message(error)}`))
                }
              />
              <span className="set-swatch" aria-hidden="true" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <Button type="submit">Save</Button>
        <span className="meta set-note" role="status">
          {note}
        </span>
      </div>
    </form>
  );
}

function Autostart() {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    invoke<boolean>("autostart_status")
      .then(setOn)
      .catch(() => setOn(false));
  }, []);
  return (
    <div className="setting">
      <label className="check">
        <input
          type="checkbox"
          checked={on ?? false}
          disabled={on === null}
          onChange={(event) => {
            invoke<boolean>("autostart_set", { enabled: event.target.checked })
              .then((now) => {
                setOn(now);
                setNote(now ? "Starts with Windows, in the tray" : "Off");
              })
              .catch((error: unknown) => setNote(`Couldn't change it: ${message(error)}`));
          }}
        />
        Start Sirna with Windows
      </label>
      <span className="meta" role="status">
        {note}
      </span>
    </div>
  );
}

/**
 * The desktop mini widget (plan §3.16): off by default, since it keeps one
 * webview alive. Shown or closed at once, no restart.
 */
function DesktopWidget() {
  const rows = useLiveQuery<{ key: string; value_json: string }>(WIDGET_SQL);
  const cheats = useLiveQuery<{ id: string; title: string | null }>(CHEATS_SQL);
  const [note, setNote] = useState("");
  // One change at a time, so the window always ends up matching the switch.
  const [busy, setBusy] = useState(false);
  const value = (key: string) => rows.rows.find((row) => row.key === key)?.value_json;
  const on = value(WIDGET_ENABLED_KEY) === "true";
  let pinned = "";
  try {
    const parsed: unknown = JSON.parse(value(WIDGET_NOTE_KEY) ?? '""');
    if (typeof parsed === "string") pinned = parsed;
  } catch {
    pinned = "";
  }
  const save = (ops: Op[], done: string) => {
    setBusy(true);
    return transact("user", ops, "widget")
      .then(() => invoke("widget_apply"))
      .then(() => setNote(done))
      .catch((error: unknown) => setNote(`Couldn't change it: ${message(error)}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className="setting">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={rows.loading || busy}
          onChange={(event) => {
            const enabled = event.target.checked;
            void save(
              [setting(WIDGET_ENABLED_KEY, enabled)],
              enabled ? "On: drag it by its top edge to place it" : "Off",
            );
          }}
        />
        Desktop widget: Now, the timer and the top 3
      </label>
      <p className="meta">
        A small window on the desktop that hides while a full-screen app is in front. While it is on
        it keeps one webview open, about 160 MB of memory; off, it uses none.
      </p>
      <label className="field">
        <span>Cheat sheet under it</span>
        <select
          value={pinned}
          disabled={!on || busy}
          onChange={(event) => void save([setting(WIDGET_NOTE_KEY, event.target.value)], "Saved")}
        >
          <option value="">None</option>
          {cheats.rows.map((cheat) => (
            <option key={cheat.id} value={cheat.id}>
              {cheat.title ?? "Untitled"}
            </option>
          ))}
        </select>
      </label>
      <span className="meta" role="status">
        {note}
      </span>
    </div>
  );
}

interface AiUsage {
  has_key: boolean;
  model: string | null;
  used: number;
  cap: number;
  quota_day: string;
}

const setting = (key: string, value: unknown) => ({
  op: "upsert" as const,
  table: "core_settings" as const,
  id: key,
  values: { value_json: JSON.stringify(value) },
});

/**
 * The model (picked from what the key can use, never built in) and the
 * daily cap (plan §7.1, §7.5).
 */
function AiSetup() {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [capText, setCapText] = useState("");
  const [note, setNote] = useState("");
  const refresh = useCallback(
    () =>
      invoke<AiUsage>("ai_usage")
        .then(setUsage)
        .catch(() => setUsage(null)),
    [],
  );
  // The limit field follows the saved limit only when that changes, so a
  // refresh (a key saved above) doesn't wipe a number you are typing.
  const [capShown, setCapShown] = useState<number | null>(null);
  if (usage && usage.cap !== capShown) {
    setCapShown(usage.cap);
    setCapText(String(usage.cap));
  }
  useEffect(() => {
    void refresh();
    // A key saved or removed above.
    const again = () => void refresh();
    window.addEventListener(AI_CHANGED_EVENT, again);
    return () => window.removeEventListener(AI_CHANGED_EVENT, again);
  }, [refresh]);
  if (!usage) return null;
  const save = (ops: ReturnType<typeof setting>[], done: string) =>
    transact("user", ops, "settings")
      .then(() => {
        setNote(done);
        // Both this section and the status strip read it again.
        window.dispatchEvent(new Event(AI_CHANGED_EVENT));
      })
      .catch((error: unknown) => setNote(`Couldn't save: ${message(error)}`));
  return (
    <div className="setting">
      <div className="set-usage">
        <span className="set-usage-count">
          <strong>{usage.used}</strong> / {usage.cap}
        </span>
        <Bar label="AI requests used today" value={usage.cap > 0 ? usage.used / usage.cap : 0} />
      </div>
      <p className="meta" role="status">
        Today: {usage.used} of {usage.cap} requests · the count resets at midnight Pacific (11:00
        here, 10:00 in US summer).
        {usage.model ? ` Model: ${usage.model}.` : " No model picked yet."}
      </p>
      <div className="row">
        <Button
          disabled={!usage.has_key}
          onClick={() => {
            setNote("Asking Google for your models…");
            invoke<{ id: string; label: string }[]>("ai_models")
              .then((list) => {
                setModels(list);
                setNote(list.length ? "" : "No models that can write text for this key.");
              })
              .catch((error: unknown) => setNote(`Couldn't list models: ${message(error)}`));
          }}
        >
          {usage.model ? "Change model" : "Pick a model"}
        </Button>
        {models.length > 0 && (
          <select
            aria-label="Model"
            value={usage.model ?? ""}
            onChange={(event) =>
              void save([setting("ai.model", event.target.value)], "Model saved")
            }
          >
            <option value="" disabled>
              Pick one (a Flash-Lite model fits the free tier)
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} ({model.id})
              </option>
            ))}
          </select>
        )}
        {!usage.has_key && <span className="meta">Save a Gemini key above first.</span>}
      </div>
      <form
        className="row set-inline"
        onSubmit={(event) => {
          event.preventDefault();
          const checked = checkDailyCap(capText);
          if ("error" in checked) setNote(checked.error);
          else void save([setting("ai.daily_cap", checked.cap)], "Daily limit saved");
        }}
      >
        <label className="field">
          <span>Requests a day at most (AI Studio shows your free-tier numbers)</span>
          <input inputMode="numeric" value={capText} onChange={(e) => setCapText(e.target.value)} />
        </label>
        <Button type="submit">Save limit</Button>
      </form>
      <span className="meta set-note" role="status">
        {note}
      </span>
    </div>
  );
}

/** Every request sent to the AI in the last 30 days, exactly as sent (R-AI-02). */
function WhatWasSent() {
  const calls = useLiveQuery<AiCall & Record<string, string | number | null>>(AI_LOG_SQL);
  const [page, setPage] = useState(0);
  if (calls.loading) return null;
  if (calls.rows.length === 0)
    return <p className="empty">Nothing sent yet. Each AI request shows here for 30 days.</p>;
  const now = systemClock.now();
  const shown = pageOf(calls.rows.length, page);
  return (
    <>
      <ul className="ai-log set-log">
        {calls.rows.slice(shown.start, shown.end).map((call) => (
          <li key={call.id}>
            <details>
              <summary>{callSummary(call, now)}</summary>
              {call.error && <p className="error">{call.error}</p>}
              <p className="meta">Sent</p>
              <pre>{pretty(call.request_redacted)}</pre>
              {call.response_text && (
                <>
                  <p className="meta">Reply</p>
                  <pre>{pretty(call.response_text)}</pre>
                </>
              )}
            </details>
          </li>
        ))}
      </ul>
      {(shown.hasNewer || shown.hasOlder) && (
        <nav className="set-log-pages" aria-label="What was sent pages">
          <Button disabled={!shown.hasNewer} onClick={() => setPage(shown.page - 1)}>
            Newer
          </Button>
          <span className="meta">{shown.label}</span>
          <Button disabled={!shown.hasOlder} onClick={() => setPage(shown.page + 1)}>
            Older
          </Button>
        </nav>
      )}
    </>
  );
}

/** One line each for Calendar, AI and Backups: fine, needs you, or not set up (T-075). */
function StatusStrip() {
  const sync = useLiveQuery<{ value_json: string | null }>(SYNC_SQL);
  const backup = useLiveQuery<{ value_json: string | null }>(BACKUP_LAST_SQL);
  const [ai, setAi] = useState<AiUsage | null>(null);
  useEffect(() => {
    const read = () =>
      void invoke<AiUsage>("ai_usage")
        .then(setAi)
        .catch(() => setAi(null));
    read();
    // A key saved, or a model or limit picked, further down this page; and
    // once a minute, so the limit line clears when the count resets.
    window.addEventListener(AI_CHANGED_EVENT, read);
    const timer = window.setInterval(read, 60_000);
    return () => {
      window.removeEventListener(AI_CHANGED_EVENT, read);
      window.clearInterval(timer);
    };
  }, []);
  if (sync.loading || backup.loading) return null;
  const lines = statusLines({
    syncJson: sync.rows[0]?.value_json,
    ai,
    backupJson: backup.rows[0]?.value_json,
    today: logicalDate(systemClock.now()),
  });
  return (
    <ul className="set-status" aria-label="Status">
      {lines.map((line) => (
        <li
          key={line.name}
          className={`panel set-stat ${line.ok === false ? "needs" : line.ok ? "fine" : "unset"}`}
        >
          <PanelHead
            level="p"
            title={
              <>
                <span className="set-dot" aria-hidden="true" />
                {line.name}
              </>
            }
            sub={
              <>
                {line.ok === false ? "Needs you: " : ""}
                {line.text}
              </>
            }
          />
        </li>
      ))}
    </ul>
  );
}

const SECTIONS = [
  { id: "set-keys", title: "Keys and links" },
  { id: "set-ai", title: "AI" },
  { id: "set-capture", title: "Capture" },
  { id: "set-look", title: "Focus and look" },
  { id: "set-windows", title: "Windows" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** One block on the canvas: its name and a line on the left, the settings on the right. */
function Section({
  id,
  icon,
  sub,
  children,
}: {
  id: SectionId;
  icon: ReactNode;
  sub: string;
  children: ReactNode;
}) {
  const title = SECTIONS.find((section) => section.id === id)?.title ?? "";
  return (
    <section className="set-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="set-label">
        <span className="set-icon">{icon}</span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="set-sub">{sub}</p>
        </div>
      </div>
      <div className="set-body">{children}</div>
    </section>
  );
}

/** The section list; on wide screens it stays in view and marks the section you are on. */
function Jump() {
  const [active, setActive] = useState<string>(SECTIONS[0]?.id ?? "");
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const scroller = listRef.current?.closest(".app-page");
    if (!scroller) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top;
      // At the bottom, the last section is the one you are on, however short.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        setActive(SECTIONS[SECTIONS.length - 1]?.id ?? "");
        return;
      }
      let current: string = SECTIONS[0]?.id ?? "";
      for (const section of SECTIONS) {
        const el = document.getElementById(section.id);
        if (el && el.getBoundingClientRect().top - top <= 140) current = section.id;
      }
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return (
    <nav ref={listRef} className="panel set-jump" aria-labelledby="set-jump-title">
      <PanelHead
        id="set-jump-title"
        title="On this page"
        sub="The theme saves at once; other parts have a Save button"
      />
      <ul className="list-rows">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              aria-current={active === section.id ? "location" : undefined}
              onClick={() =>
                document
                  .getElementById(section.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {section.title}
              <IconArrowRight size={16} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Keys, links and preferences, all changeable here (nothing is built in). */
export function Settings() {
  const settings = useLiveQuery<{ key: string; value_json: string | null }>(SETTINGS_SQL);
  return (
    <main className="page settings-page">
      <div className="layout-split">
        <aside className="side" aria-label="Status and sections">
          <StatusStrip />
          <Jump />
        </aside>

        <div className="main">
          <div className="canvas set-canvas">
            <header className="canvas-head">
              <h1 className="page-title">
                Settings, <span className="soft">keys and look</span>
              </h1>
            </header>
            <p className="set-lead">
              Keys and links are kept in Windows Credential Manager, not in Sirna&apos;s database,
              and are never shown again once saved. Replace or remove them here at any time.
            </p>

            <Section id="set-keys" icon={<IconSettings size={18} />} sub="Saved outside Sirna">
              {SECRETS.map((secret) => (
                <SecretField key={secret.name} {...secret} />
              ))}
              <CalendarStatus />
              <p className="meta set-aside">
                Email: Sirna doesn&apos;t sign in to email, so there is no email password to store.
                The &ldquo;Check email&rdquo; blocks only remind you; change their times in Plan,
                Routine.
              </p>
            </Section>

            <Section id="set-ai" icon={<IconBolt size={18} />} sub="Gemini phrases, Sirna decides">
              <p className="meta set-aside">
                Gemini only phrases and suggests; the numbers and verdicts are Sirna&apos;s own.
                Without a key, offline or over the limit, everything still works with plain text.
              </p>
              <AiSetup />
              <div className="setting">
                <StrictMode />
              </div>
              <div className="setting">
                <h3 className="set-subhead">What was sent</h3>
                <WhatWasSent />
              </div>
            </Section>

            <Section id="set-capture" icon={<IconPencil size={18} />} sub="One key, from anywhere">
              <CaptureKey />
            </Section>

            <Section id="set-look" icon={<IconSun size={18} />} sub="Daily cap, quiet and theme">
              {settings.error && (
                <p role="alert" className="error">
                  Couldn&apos;t load settings: {settings.error}
                </p>
              )}
              {!settings.loading && <FocusAndLook initial={readSettings(settings.rows)} />}
            </Section>

            <Section id="set-windows" icon={<IconExpand size={18} />} sub="Start-up and the widget">
              <Autostart />
              <DesktopWidget />
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Strict mode (plan §7.4): area names instead of titles; no free text sent. */
function StrictMode() {
  const rows = useLiveQuery<{ value_json: string | null }>(
    "SELECT value_json FROM core_settings WHERE key = 'ai.strict'",
  );
  const on = rows.rows[0]?.value_json === "true";
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={on}
        disabled={rows.loading}
        onChange={(event) =>
          void transact("user", [setting("ai.strict", event.target.checked)], "settings")
        }
      />
      Strict mode: send area names instead of task and project titles, and never send what you write
      in the night review
    </label>
  );
}
