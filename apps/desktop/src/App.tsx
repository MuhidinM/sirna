import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { query } from "./kernel/db";
import { SETUP_DONE_KEY } from "./features/plan/setup";
import { Kits } from "./shell/Kits";
import { Notes } from "./shell/Notes";
import { Review } from "./shell/Review";
import { Setup } from "./shell/Setup";
import { Today } from "./shell/Today";

type Screen = "loading" | "setup" | "today" | "review" | "kits" | "notes";

/**
 * A screen Rust asked for (tray, toast, capture box): "review", or
 * "notes:<query>" from `? query` in the capture box.
 */
export function readPending(pending: string | null): { screen?: Screen; notesQuery: string } {
  if (pending === "review") return { screen: "review", notesQuery: "" };
  if (pending?.startsWith("notes:")) return { screen: "notes", notesQuery: pending.slice(6) };
  return { notesQuery: "" };
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Each search from the capture box remounts Notes with its query.
  const [notes, setNotes] = useState({ query: "", visit: 0 });

  useEffect(() => {
    const open = (pending: string | null) => {
      const { screen: next, notesQuery } = readPending(pending);
      if (next === "notes") setNotes((old) => ({ query: notesQuery, visit: old.visit + 1 }));
      return next;
    };
    Promise.all([
      query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
        SETUP_DONE_KEY,
      ]),
      invoke<string | null>("take_screen").catch(() => null),
    ])
      .then(([[row], pending]) => {
        if (row?.value_json !== "true") setScreen("setup");
        else setScreen(open(pending) ?? "today");
      })
      .catch(() => setScreen("today"));

    const unlisten = listen<string>("show-screen", (event) => {
      void invoke("take_screen").catch(() => null);
      const next = open(event.payload);
      if (next) setScreen(next);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const home = () => setScreen("today");
  if (screen === "loading") return null;
  if (screen === "setup") return <Setup onDone={home} />;
  if (screen === "review") return <Review onClose={home} />;
  if (screen === "kits") return <Kits onClose={home} />;
  if (screen === "notes")
    return <Notes key={notes.visit} initialQuery={notes.query} onClose={home} />;
  return (
    <Today
      onChangeWeek={() => setScreen("setup")}
      onReview={() => setScreen("review")}
      onKits={() => setScreen("kits")}
      onNotes={() => {
        setNotes((old) => ({ query: "", visit: old.visit + 1 }));
        setScreen("notes");
      }}
    />
  );
}
