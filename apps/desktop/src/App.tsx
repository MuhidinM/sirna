import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { query } from "./kernel/db";
import { SETUP_DONE_KEY } from "./features/plan/setup";
import { Kits } from "./shell/Kits";
import { Nav, type Page } from "./shell/Nav";
import { Notes } from "./shell/Notes";
import { Projects } from "./shell/Projects";
import { Review } from "./shell/Review";
import { Settings } from "./shell/Settings";
import { Setup } from "./shell/Setup";
import { Tasks } from "./shell/Tasks";
import { Today } from "./shell/Today";
import { Week } from "./shell/Week";

/** "setup" is the first run (no sidebar); "week" is the same form later. */
type Screen = "loading" | "setup" | Page;

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
  // "Start over" in My week shows the setup questions again.
  const [rebuild, setRebuild] = useState(false);

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
  const go = (page: Page) => {
    setRebuild(false);
    // Opening Cheat sheets from the sidebar starts with an empty search.
    if (page === "notes") setNotes((old) => ({ query: "", visit: old.visit + 1 }));
    setScreen(page);
  };
  if (screen === "loading") return null;
  if (screen === "setup") return <Setup onDone={home} />;

  let page;
  if (screen === "week")
    page = rebuild ? (
      <Setup
        onDone={() => {
          setRebuild(false);
          home();
        }}
      />
    ) : (
      <Week onStartOver={() => setRebuild(true)} />
    );
  else if (screen === "review") page = <Review onClose={home} />;
  else if (screen === "kits") page = <Kits onClose={home} />;
  else if (screen === "settings") page = <Settings />;
  else if (screen === "projects") page = <Projects />;
  else if (screen === "tasks") page = <Tasks />;
  else if (screen === "notes")
    page = <Notes key={notes.visit} initialQuery={notes.query} onClose={home} />;
  else page = <Today />;
  return (
    <div className="app-shell">
      <Nav current={screen} onGo={go} />
      {/* Keyed by page, so each page opens at the top. */}
      <div className="app-page" key={screen}>
        {page}
      </div>
    </div>
  );
}
