import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import { transact } from "../kernel/db";
import {
  checkCap,
  cleanSecret,
  readSettings,
  SECRETS,
  SETTINGS_SQL,
  settingsOps,
  type SettingsValues,
} from "../features/settings/settings";
import { applyTheme } from "../theme/theme";
import { AI_LOG_SQL, type AiCall, callSummary, checkDailyCap, pretty } from "../features/ai/log";
import { systemClock } from "../kernel/clock";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

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
        <Button type="submit" primary disabled={!cleanSecret(text)}>
          {saved ? "Replace" : "Save"}
        </Button>
        {saved && <Button onClick={() => void store("", "Removed")}>Remove</Button>}
        <span className="meta" role="status">
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
        <Button type="submit" primary disabled={!text.trim()}>
          Use this key
        </Button>
        <Button onClick={() => void apply("")}>Back to default</Button>
        <span className="meta" role="status">
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
        const next = { ...values, capMin: cap.minutes };
        transact("user", settingsOps(next), "settings")
          .then(() => {
            applyTheme(next.theme);
            setNote("Saved");
          })
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
      <label className="field">
        <span>Theme</span>
        <select
          value={values.theme}
          onChange={(event) =>
            change({ ...values, theme: event.target.value === "light" ? "light" : "dark" })
          }
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <div className="row">
        <Button type="submit" primary>
          Save
        </Button>
        <span className="meta" role="status">
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
        .then((now) => {
          setUsage(now);
          setCapText(String(now.cap));
        })
        .catch(() => setUsage(null)),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!usage) return null;
  const save = (ops: ReturnType<typeof setting>[], done: string) =>
    transact("user", ops, "settings")
      .then(() => {
        setNote(done);
        return refresh();
      })
      .catch((error: unknown) => setNote(`Couldn't save: ${message(error)}`));
  return (
    <div className="setting">
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
        className="row"
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
      <span className="meta" role="status">
        {note}
      </span>
    </div>
  );
}

/** Every request sent to the AI in the last 30 days, exactly as sent (R-AI-02). */
function WhatWasSent() {
  const calls = useLiveQuery<AiCall & Record<string, string | number | null>>(AI_LOG_SQL);
  if (calls.loading) return null;
  if (calls.rows.length === 0) return <p className="meta">Nothing has been sent.</p>;
  const now = systemClock.now();
  return (
    <ul className="ai-log">
      {calls.rows.map((call) => (
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
  );
}

/** Keys, links and preferences, all changeable here (nothing is built in). */
export function Settings() {
  const settings = useLiveQuery<{ key: string; value_json: string | null }>(SETTINGS_SQL);
  return (
    <main className="review settings">
      <header className="review-head">
        <h1>Settings</h1>
        <p className="meta">
          Keys and links are kept in Windows Credential Manager, not in Sirna&apos;s database, and
          are never shown again once saved. Replace or remove them here at any time.
        </p>
      </header>

      <section className="card">
        <h2>Keys and links</h2>
        {SECRETS.map((secret) => (
          <SecretField key={secret.name} {...secret} />
        ))}
        <p className="meta">
          Email: Sirna doesn&apos;t sign in to email, so there is no email password to store. The
          &ldquo;Check email&rdquo; blocks only remind you; change their times in My week.
        </p>
      </section>

      <section className="card">
        <h2>AI</h2>
        <p className="meta">
          Gemini only phrases and suggests; the numbers and verdicts are Sirna&apos;s own. Without a
          key, offline or over the limit, everything still works with plain text.
        </p>
        <AiSetup />
        <h3>What was sent</h3>
        <WhatWasSent />
      </section>

      <section className="card">
        <h2>Capture</h2>
        <CaptureKey />
      </section>

      <section className="card">
        <h2>Focus and look</h2>
        {settings.error && (
          <p role="alert" className="error">
            Couldn&apos;t load settings: {settings.error}
          </p>
        )}
        {!settings.loading && <FocusAndLook initial={readSettings(settings.rows)} />}
      </section>

      <section className="card">
        <h2>Windows</h2>
        <Autostart />
      </section>
    </main>
  );
}
