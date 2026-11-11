import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { kitOps, KITS_SQL, kitText, toJson, toLines } from "./kits";

describe("lines and JSON", () => {
  it("round-trips, trimming blanks and repeats", () => {
    expect(toJson(" Telegram.exe \n\n Discord\r\nTelegram.exe ")).toBe(
      '["Telegram.exe","Discord"]',
    );
    expect(toLines('["a","b"]')).toBe("a\nb");
  });

  it("treats bad or missing JSON as empty", () => {
    expect(toLines(null)).toBe("");
    expect(toLines("nope")).toBe("");
    expect(toLines('{"a":1}')).toBe("");
    expect(toLines('["a", 3]')).toBe("a");
  });
});

describe("kits", () => {
  it("lists active areas with their seeded kits", () => {
    const db = openTestDb();
    const rows = db.prepare(KITS_SQL).all() as unknown as Parameters<typeof kitText>[0][];
    const coding = rows.find((row) => row.area_id === "coding");
    expect(coding && kitText(coding).minimize).toBe("Telegram.exe");
    expect(rows.map((row) => row.area_id)).toContain("gym");
  });

  it("saves a kit as one upsert", () => {
    expect(
      kitOps("coding", {
        open: "code D:\\sirna\nhttps://docs.rs",
        minimize: "",
        checklist: "Water",
      }),
    ).toEqual([
      {
        op: "upsert",
        table: "focus_kits",
        id: "coding",
        values: {
          open_json: '["code D:\\\\sirna","https://docs.rs"]',
          minimize_json: "[]",
          checklist_json: '["Water"]',
        },
      },
    ]);
  });
});
