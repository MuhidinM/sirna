import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { toOps } from "../../capture/ops";
import { parseCapture } from "../../capture/parse";
import {
  type Card,
  cardText,
  CHEAT_SQL,
  type CheatRow,
  editOps,
  groupCards,
  search,
  tokens,
} from "./cheat";

const now = Date.parse("2026-11-11T12:00:00+03:00");

function pin(db: ReturnType<typeof openTestDb>, text: string, id: string, at = now) {
  const parsed = parseCapture(text, { nowMs: at });
  for (const op of toOps(parsed, { nowMs: at, newId: () => id })) {
    if (op.op !== "insert") continue;
    const values = { ...op.values, created_at: at, updated_at: at };
    const columns = Object.keys(values);
    db.prepare(
      `INSERT INTO ${op.table} (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
    ).run(op.id, ...(Object.values(values) as never[]));
  }
}

const rows = (db: ReturnType<typeof openTestDb>) =>
  db.prepare(CHEAT_SQL).all() as unknown as CheatRow[];

describe("cards from pins", () => {
  it("groups pinned lines by area, tag and General, in order", () => {
    const db = openTestDb();
    pin(db, "pin: undo last commit = git reset --soft HEAD~1 #coding", "a", now);
    pin(db, "pin: elevator pitch: backend dev who ships", "b", now + 1);
    pin(db, "pin: squash = git rebase -i #coding", "c", now + 2);
    pin(db, "pin: Juz 3, page 42 #quran", "d", now + 3);
    pin(db, "pin: wifi at the gym is GymGuest #gymwifi", "e", now + 4);

    const cards = groupCards(rows(db));
    expect(cards.map((card) => [card.title, card.lines.map((line) => line.id)])).toEqual([
      ["Quran", ["d"]],
      ["Coding skills", ["a", "c"]],
      ["Gymwifi", ["e"]],
      ["General", ["b"]],
    ]);
  });

  it("keeps an edited order, then appends new pins", () => {
    const db = openTestDb();
    pin(db, "pin: first #coding", "a", now);
    pin(db, "pin: second #coding", "b", now + 1);
    db.prepare("UPDATE note_items SET sort_order = 0 WHERE id = 'b'").run();
    db.prepare("UPDATE note_items SET sort_order = 1 WHERE id = 'a'").run();
    pin(db, "pin: third #coding", "c", now + 2);
    expect(groupCards(rows(db))[0]?.lines.map((line) => line.id)).toEqual(["b", "a", "c"]);
  });

  it("leaves out deleted and undone lines", () => {
    const db = openTestDb();
    pin(db, "pin: kept #coding", "a");
    pin(db, "pin: gone #coding", "b");
    db.prepare("UPDATE note_items SET deleted_at = 1 WHERE id = 'b'").run();
    expect(rows(db).map((row) => row.id)).toEqual(["a"]);
  });
});

const card: Card = {
  key: "coding",
  title: "Coding skills",
  lines: [
    { id: "a", body: "undo last commit = `git reset --soft HEAD~1`" },
    { id: "b", body: "squash = git rebase -i" },
  ],
};

describe("search", () => {
  it("matches every word, any case, including the card title", () => {
    expect(search([card], "RESET soft").map((hit) => hit.line.id)).toEqual(["a"]);
    expect(search([card], "coding squash").map((hit) => hit.line.id)).toEqual(["b"]);
    expect(search([card], "nothing here")).toEqual([]);
    expect(search([card], "  ")).toEqual([]);
  });
});

describe("editOps", () => {
  it("updates in place, inserts new lines and deletes removed ones", () => {
    let n = 0;
    const ops = editOps(card, "squash = git rebase -i\n\nnew line\n", () => `new${++n}`);
    expect(ops).toEqual([
      {
        op: "update",
        table: "note_items",
        id: "a",
        values: { body: "squash = git rebase -i", sort_order: 0 },
      },
      { op: "update", table: "note_items", id: "b", values: { body: "new line", sort_order: 1 } },
    ]);
    const grown = editOps(card, `${cardText(card)}\nthird`, () => "n1");
    expect(grown.at(-1)).toMatchObject({
      op: "insert",
      id: "n1",
      values: { kind: "cheat", area_id: "coding", sort_order: 2, body: "third" },
    });
    expect(editOps(card, "only one", () => "x").at(-1)).toEqual({
      op: "delete",
      table: "note_items",
      id: "b",
    });
  });

  it("never touches a line pinned after the editor opened", () => {
    // The screen diffs against the card as it was when Edit was pressed.
    const base = card;
    const ops = editOps(base, cardText(base).replace("squash", "squash all"), () => "x");
    const live = [...base.lines, { id: "pinned-meanwhile", body: "git stash pop" }];
    expect(ops.some((op) => op.id === "pinned-meanwhile")).toBe(false);
    expect(live).toHaveLength(3);
  });

  it("puts new General lines under no area", () => {
    const general: Card = { key: "", title: "General", lines: [] };
    expect(editOps(general, "a line", () => "g1")[0]).toMatchObject({ values: { area_id: null } });
  });
});

describe("tokens", () => {
  it("reads `code` and **bold**", () => {
    expect(tokens("undo = `git reset` **careful** done")).toEqual([
      { kind: "text", text: "undo = " },
      { kind: "code", text: "git reset" },
      { kind: "text", text: " " },
      { kind: "bold", text: "careful" },
      { kind: "text", text: " done" },
    ]);
    expect(tokens("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(tokens("unclosed `tick")).toEqual([{ kind: "text", text: "unclosed `tick" }]);
  });
});
