/**
 * The status strip at the top of Settings (T-075; proposal 4.7): one line each
 * for Calendar, AI and Backups — fine, needs you, or not set up — with the
 * fix in words. Pure and tested.
 */
import { shiftDate } from "../plan/dayplan";
import { readStatus, statusText } from "../calendar/sync";

export interface AiUsage {
  has_key: boolean;
  model: string | null;
  used: number;
  cap: number;
}

export interface StatusLine {
  name: "Calendar" | "AI" | "Backups";
  /** true = fine, false = needs you, null = not set up (and that's fine). */
  ok: boolean | null;
  text: string;
}

/** Sent after the AI key, model or limit changes, so the strip reads ai_usage again. */
export const AI_CHANGED_EVENT = "sirna:ai-changed";

export const BACKUP_LAST_SQL = "SELECT value_json FROM core_settings WHERE key = 'backup.last'";

/** A backup older than this many days needs a look. */
export const BACKUP_STALE_DAYS = 2;

export function statusLines(input: {
  syncJson: string | null | undefined;
  ai: AiUsage | null;
  backupJson: string | null | undefined;
  today: string;
}): StatusLine[] {
  const lines: StatusLine[] = [];

  const sync = readStatus(input.syncJson);
  if (!sync || sync.code === "no-link")
    lines.push({
      name: "Calendar",
      ok: null,
      text: "Not set up: paste your Google Calendar secret iCal address below.",
    });
  else
    lines.push({
      name: "Calendar",
      // Offline passes by itself and Sirna retries, so it isn't "needs you" (as in the brief).
      ok: sync.held ? false : sync.code === "ok" ? true : sync.code === "offline" ? null : false,
      text: statusText(sync),
    });

  const ai = input.ai;
  if (!ai || !ai.has_key)
    lines.push({
      name: "AI",
      ok: null,
      text: "Off. Add a Gemini key below for wording help; everything works without it.",
    });
  else if (!ai.model)
    lines.push({
      name: "AI",
      ok: false,
      text: "Key saved, but no model picked: choose one under AI.",
    });
  else if (ai.used >= ai.cap)
    lines.push({
      name: "AI",
      ok: false,
      // The free tier counts by the Pacific day: midnight there is 11:00 here (10:00 in US summer).
      text: `Today's limit reached (${ai.used} of ${ai.cap}); it resets at 11:00 (10:00 in US summer).`,
    });
  else
    lines.push({
      name: "AI",
      ok: true,
      text: `${ai.model} · ${ai.used} of ${ai.cap} requests used today.`,
    });

  let last: string | null = null;
  try {
    const value: unknown = JSON.parse(input.backupJson ?? "null");
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) last = value;
  } catch {
    last = null;
  }
  if (last === null)
    lines.push({ name: "Backups", ok: null, text: "The first daily backup is made tonight." });
  else if (last < shiftDate(input.today, -BACKUP_STALE_DAYS))
    lines.push({
      name: "Backups",
      ok: false,
      text: `Last backup ${last}: check the backup folder still exists and has space.`,
    });
  else lines.push({ name: "Backups", ok: true, text: `Last backup ${last}.` });

  return lines;
}
