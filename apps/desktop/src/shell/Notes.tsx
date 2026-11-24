import "../theme/pages/plan-review.css";

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import { transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  type Card,
  cardText,
  CHEAT_SQL,
  type CheatRow,
  editOps,
  groupCards,
  LONG_CARD,
  search,
  tokens,
} from "../features/notes/cheat";
import { IconSearch } from "./icons";
import { cancelOnEscape } from "./keys";
import { PanelHead, type Tone, toneOf } from "./kit";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

function Line({ text }: { text: string }) {
  return (
    <>
      {tokens(text).map((token, index) =>
        token.kind === "code" ? (
          <code key={index}>{token.text}</code>
        ) : token.kind === "bold" ? (
          <strong key={index}>{token.text}</strong>
        ) : (
          <span key={index}>{token.text}</span>
        ),
      )}
    </>
  );
}

interface LastSave {
  context: string;
  title: string;
}

const AREA_COLORS_SQL = "SELECT id, color FROM area_items WHERE deleted_at IS NULL";

function CardView({
  card,
  tone,
  onSaved,
}: {
  card: Card;
  tone: Tone;
  onSaved: (save: LastSave) => void;
}) {
  // The card as it was when Edit was pressed: a pin that arrives while the
  // editor is open is not in the text, so it must not be in the diff either.
  const [editing, setEditing] = useState<{ text: string; base: Card }>();
  const [error, setError] = useState<string>();

  const save = async (text: string, base: Card) => {
    const context = `notes:${ulid()}`;
    const ops = editOps(base, text, () => ulid());
    try {
      if (ops.length > 0) await transact("user", ops, context);
      setEditing(undefined);
      setError(undefined);
      if (ops.length > 0) onSaved({ context, title: card.title });
    } catch (failure) {
      setError(`Couldn't save: ${String(failure)}`);
    }
  };

  return (
    <section className={`card pr-card pr-cheat tone-${tone}`} aria-label={card.title}>
      <PanelHead
        icon={<span aria-hidden="true">{card.title.charAt(0).toUpperCase() || "#"}</span>}
        title={card.title}
        sub={`${card.lines.length} line${card.lines.length === 1 ? "" : "s"}`}
        action={
          editing === undefined && (
            <Button onClick={() => setEditing({ text: cardText(card), base: card })}>Edit</Button>
          )
        }
      />
      {editing === undefined ? (
        <ul className="cheat-lines pr-lines">
          {card.lines.map((line) => (
            <li key={line.id}>
              <Line text={line.body} />
            </li>
          ))}
        </ul>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels; keydown bubbles from its fields
        <form
          onKeyDown={cancelOnEscape(() => setEditing(undefined))}
          onSubmit={(event) => {
            event.preventDefault();
            void save(editing.text, editing.base);
          }}
        >
          <label className="field">
            <span>One line each. Use `code` and **bold**.</span>
            <textarea
              rows={Math.min(14, Math.max(4, editing.text.split("\n").length + 1))}
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            />
          </label>
          <div className="pr-card-foot">
            <Button className="btn-ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button type="submit" className="rv-dark">
              Save
            </Button>
          </div>
        </form>
      )}
      {card.lines.length > LONG_CARD && (
        <p className="hint pr-long">
          {card.lines.length} lines: cheat sheets work best short. Split it with a new #tag?
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Cheat sheets (plan §3.15): one card per area, `pin:` adds lines. */
export function Notes({
  initialQuery = "",
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const rows = useLiveQuery<CheatRow & Record<string, string | null>>(CHEAT_SQL);
  const [queryText, setQueryText] = useState(initialQuery);
  // Page-level, so Undo stays even when a save emptied (and removed) its card.
  const [lastSave, setLastSave] = useState<LastSave>();
  const [message, setMessage] = useState<string>();
  const cards = groupCards(rows.rows);
  const hits = search(cards, queryText);

  const undo = async () => {
    if (!lastSave) return;
    try {
      await invoke<number>("notes_undo", { context: lastSave.context });
      setMessage(`Undid the change to ${lastSave.title}`);
      setLastSave(undefined);
    } catch (error) {
      setMessage(`Couldn't undo: ${String(error)}`);
    }
  };

  const colors = useLiveQuery<{ id: string; color: string }>(AREA_COLORS_SQL);
  const colorOf = new Map(colors.rows.map((area) => [area.id, area.color]));

  return (
    <main className="page plan-review">
      <section className="canvas pr notes" aria-labelledby="notes-title">
        <header className="canvas-head">
          <h1 id="notes-title" className="page-title">
            Cheat <span className="soft">sheets</span>
          </h1>
          <label className="search pr-search">
            <IconSearch size={16} />
            <span className="visually-hidden">Search</span>
            <input
              type="search"
              value={queryText}
              placeholder="Search cheat lines"
              onChange={(event) => setQueryText(event.target.value)}
            />
          </label>
          <span className="spacer" />
          <Button onClick={onClose}>Back to today</Button>
        </header>
        <p className="pr-intro meta">
          Add a line from anywhere: <code>pin: git undo = git reset --soft HEAD~1 #coding</code>
        </p>
        {rows.error && (
          <p role="alert" className="error">
            Couldn&apos;t load the notes: {rows.error}
          </p>
        )}
        {(lastSave ?? message) && (
          <p className="notice pr-status" role="status">
            {lastSave ? `Saved ${lastSave.title}` : message}
            {lastSave && <Button onClick={() => void undo()}>Undo</Button>}
          </p>
        )}
        {queryText.trim() !== "" ? (
          <section className="card pr-card pr-results" aria-label="Search results">
            <PanelHead
              title="Matches"
              sub={`${hits.length} line${hits.length === 1 ? "" : "s"} for “${queryText.trim()}”`}
            />
            {hits.length === 0 ? (
              <p className="empty">No cheat lines match. Try another word.</p>
            ) : (
              <ul className="cheat-lines pr-lines">
                {hits.map((hit) => (
                  <li key={hit.line.id} className="pr-hit">
                    <span className="grow">
                      <Line text={hit.line.body} />
                    </span>
                    <span className={`chip tone-${toneOf(colorOf.get(hit.card.key))} pr-chip`}>
                      {hit.card.title}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : !rows.loading && cards.length === 0 ? (
          <p className="empty">
            No cheat sheets yet. Type <code>pin: …</code> in the capture box to start one.
          </p>
        ) : (
          <div className="pr-grid">
            {cards.map((card) => (
              <CardView
                key={card.key}
                card={card}
                tone={toneOf(colorOf.get(card.key))}
                onSaved={(save) => {
                  setLastSave(save);
                  setMessage(undefined);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
