import { useState } from "react";

import { transact } from "../kernel/db";
import { kitOps, KITS_SQL, type KitRow, kitText, type KitText } from "../features/focus/kits";
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

function KitForm({ row }: { row: KitRow }) {
  const [text, setText] = useState<KitText>(() => kitText(row));
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="kit card"
      onSubmit={(event) => {
        event.preventDefault();
        void transact("user", kitOps(row.area_id, text), "kits").then(() => setSaved(true));
      }}
    >
      <h2>{row.name}</h2>
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
      <div className="row">
        <Button type="submit" primary>
          Save
        </Button>
        {saved && <span className="meta">Saved</span>}
      </div>
    </form>
  );
}

/** Focus kits per area (plan §3.6a): one entry per line. */
export function Kits({ onClose }: { onClose: () => void }) {
  const kits = useLiveQuery<KitRow & Record<string, string | null>>(KITS_SQL);
  return (
    <main className="review kits">
      <header className="review-head">
        <h1>Focus kits</h1>
        <p className="meta">
          What happens when a session starts in each area. Programs are only minimized, never
          closed.
        </p>
        <Button onClick={onClose}>Back to today</Button>
      </header>
      {kits.error && (
        <p role="alert" className="error">
          Couldn&apos;t load the kits: {kits.error}
        </p>
      )}
      {!kits.loading && kits.rows.map((row) => <KitForm key={row.area_id} row={row} />)}
    </main>
  );
}
