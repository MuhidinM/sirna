import { describe, expect, it } from "vitest";

import { readPending } from "./App";

describe("readPending", () => {
  it("opens the review, or Notes with the capture box's query", () => {
    expect(readPending("review")).toEqual({ screen: "review", notesQuery: "" });
    expect(readPending("notes:git reset")).toEqual({ screen: "notes", notesQuery: "git reset" });
    expect(readPending("notes:")).toEqual({ screen: "notes", notesQuery: "" });
  });

  it("ignores nothing or anything unknown", () => {
    expect(readPending(null)).toEqual({ notesQuery: "" });
    expect(readPending("something")).toEqual({ notesQuery: "" });
  });
});
