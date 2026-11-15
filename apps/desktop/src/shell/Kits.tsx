import "../theme/pages/plan-review.css";

import { useState } from "react";

import { transact } from "../kernel/db";
import { kitOps, KITS_SQL, type KitRow, kitText, type KitText } from "../features/focus/kits";
import { type Tone, toneOf } from "./kit";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const FIELDS: [keyof KitText, string, string][] = [
  [
    "open",
    "Open when a session starts",
    "code D:\\Projects\\sirna\nhttps://jobs.example.com\nD:\\Docs\\CV",
  ],
  ["minimize", "Minimize (never closed)", "Telegram.exe\nDiscord.exe"],
  ["checklist", "Checklist on the sheet", "Phone in another room\nWater on the desk"],
];

/** Each active area's theme colour, to tint its card. */
const AREA_COLORS_SQL = "SELECT id, color FROM area_items WHERE deleted_at IS NULL";

const lineCount = (text: string) => text.split("\n").filter((line) => line.trim()).length;

function KitForm({ row, tone }: { row: KitRow; tone: Tone }) {
  const [text, setText] = useState<KitText>(() => kitText(row));
  const [saved, setSaved] = useState(false);
  return (
    <form
      className={`card pr-card pr-kit tone-${tone}`}
      aria-label={`${row.name} kit`}
      onSubmit={(event) => {
        event.preventDefault();
        void transact("user", kitOps(row.area_id, text), "kits").then(() => setSaved(true));
      }}
    >
      <header className="pr-kit-head">
        <span className="pr-kit-label">Focus kit</span>
        <h2>{row.name}</h2>
        <span className="pr-kit-count">
          {lineCount(text.open)} open · {lineCount(text.minimize)} minimized ·{" "}
          {lineCount(text.checklist)} to check
        </span>
      </header>
      <div className="pr-kit-body">
        {FIELDS.map(([key, label, placeholder]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <textarea
              rows={3}
              value={text[key]}
              placeholder={placeholder}
              onChange={(event) => {
                setSaved(false);
                setText({ ...text, [key]: event.target.value });
              }}
            />
          </label>
        ))}
        <div className="pr-card-foot">
          {saved && <span className="meta">Saved</span>}
          <Button type="submit" className="rv-dark">
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Focus kits per area (plan §3.6a): one entry per line. */
export function Kits({ onClose }: { onClose: () => void }) {
  const kits = useLiveQuery<KitRow & Record<string, string | null>>(KITS_SQL);
  const colors = useLiveQuery<{ id: string; color: string }>(AREA_COLORS_SQL);
  const colorOf = new Map(colors.rows.map((area) => [area.id, area.color]));
  return (
    <main className="page plan-review">
      <section className="canvas pr" aria-labelledby="kits-title">
        <header className="canvas-head">
          <h1 id="kits-title" className="page-title">
            Focus <span className="soft">kits</span>
          </h1>
          <span className="spacer" />
          <Button onClick={onClose}>Back to today</Button>
        </header>
        <p className="pr-intro meta">
          What happens when a session starts in each area. Programs are only minimized, never
          closed. One entry per line.
        </p>
        {kits.error && (
          <p role="alert" className="error">
            Couldn&apos;t load the kits: {kits.error}
          </p>
        )}
        {!kits.loading && kits.rows.length === 0 && !kits.error && (
          <p className="empty">No active areas yet.</p>
        )}
        <div className="pr-grid">
          {!kits.loading &&
            kits.rows.map((row) => (
              <KitForm key={row.area_id} row={row} tone={toneOf(colorOf.get(row.area_id))} />
            ))}
        </div>
      </section>
    </main>
  );
}
