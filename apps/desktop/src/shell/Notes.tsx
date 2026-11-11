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

function CardView({ card, onSaved }: { card: Card; onSaved: (save: LastSave) => void }) {
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
    <section className="cheat card" aria-label={card.title}>
      <header className="row">
        <h2>{card.title}</h2>
        {editing === undefined && (
          <Button onClick={() => setEditing({ text: cardText(card), base: card })}>Edit</Button>
        )}
      </header>
      {editing === undefined ? (
        <ul className="cheat-lines">
          {card.lines.map((line) => (
            <li key={line.id}>
              <Line text={line.body} />
            </li>
          ))}
        </ul>
      ) : (
        <form
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
          <div className="row">
            <Button type="submit" primary>
              Save
            </Button>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {card.lines.length > LONG_CARD && (
        <p className="meta">
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

  return (
    <main className="review notes">
      <header className="review-head">
        <h1>Cheat sheets</h1>
        <p className="meta">
          Add a line from anywhere: <code>pin: git undo = git reset --soft HEAD~1 #coding</code>
        </p>
        <Button onClick={onClose}>Back to today</Button>
      </header>
      <label className="field">
        <span>Search</span>
        <input
          type="search"
          value={queryText}
          placeholder="reset"
          onChange={(event) => setQueryText(event.target.value)}
        />
      </label>
      {rows.error && (
        <p role="alert" className="error">
          Couldn&apos;t load the notes: {rows.error}
        </p>
      )}
      {(lastSave ?? message) && (
        <p className="row meta" role="status">
          {lastSave ? `Saved ${lastSave.title}` : message}
          {lastSave && <Button onClick={() => void undo()}>Undo</Button>}
        </p>
      )}
      {queryText.trim() !== "" ? (
        <section aria-label="Search results">
          {hits.length === 0 ? (
            <p className="empty">No cheat line matches.</p>
          ) : (
            <ul className="cheat-lines">
              {hits.map((hit) => (
                <li key={hit.line.id} className="task">
                  <span>
                    <Line text={hit.line.body} />
                  </span>
                  <span className="meta">{hit.card.title}</span>
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
        cards.map((card) => (
          <CardView
            key={card.key}
            card={card}
            onSaved={(save) => {
              setLastSave(save);
              setMessage(undefined);
            }}
          />
        ))
      )}
    </main>
  );
}
