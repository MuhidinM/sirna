import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { query, transact } from "./kernel/db";
import { ulid } from "./kernel/ulid";
import { healPlans } from "./features/plan/dayplan";
import { systemClock } from "./kernel/clock";
import { logicalDate } from "./kernel/dates";
import { applyTheme, LOOK_SQL, THEME_EVENT, themeFromSetting } from "./theme/theme";
import { SETUP_DONE_KEY } from "./features/plan/setup";
import { useCalendarSync } from "./shell/Calendar";
import { Kits } from "./shell/Kits";
import { Money } from "./shell/Money";
import { isPlanPage, Nav, type Page, PlanTabs } from "./shell/Nav";
import { Dashboard } from "./shell/Dashboard";
import { DayPlan } from "./shell/DayPlan";
import { Notes } from "./shell/Notes";
import { Projects } from "./shell/Projects";
import { Review } from "./shell/Review";
import { Settings } from "./shell/Settings";
import { Setup } from "./shell/Setup";
import { Tasks } from "./shell/Tasks";
import { Today } from "./shell/Today";
import { Week } from "./shell/Week";
import { WeekCard } from "./shell/WeekCard";

/** "setup" is the first run (no sidebar); "week" is the same form later. */
type Screen = "loading" | "setup" | Page;

/**
 * A screen Rust asked for (tray, toast, capture box): "review", or
 * "notes:<query>" from `? query` in the capture box.
 */
export function readPending(pending: string | null): { screen?: Screen; notesQuery: string } {
  if (pending === "review") return { screen: "review", notesQuery: "" };
  if (pending === "money") return { screen: "money", notesQuery: "" };
  if (pending?.startsWith("notes:")) return { screen: "notes", notesQuery: pending.slice(6) };
  return { notesQuery: "" };
}

/** A data change that can give a planned day a task to place (time first §1 rule 1). */
export function touchesTasks(tables: unknown): boolean {
  return Array.isArray(tables) && tables.some((table) => table === "task_items" || table === "day");
}

/**
 * Keeps planned days in step with tasks: when the window opens (captures made
 * while it was closed) and after every task change, a planned day gets blocks
 * for tasks timed or windowed after it was planned. One run at a time; a
 * change during a run runs it once more.
 */
function usePlanHealing(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let running = false;
    let again = false;
    let stopped = false;
    const heal = () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      void healPlans(
        query,
        (ops) => transact("system", ops, "day-plan"),
        systemClock.now(),
        () => ulid(),
      )
        .catch((error: unknown) => console.error("could not update the plan", error))
        .finally(() => {
          running = false;
          if (again && !stopped) {
            again = false;
            heal();
          }
        });
    };
    heal();
    const unlisten = listen<unknown>("data-changed", (event) => {
      if (touchesTasks(event.payload)) heal();
    });
    return () => {
      stopped = true;
      void unlisten.then((stop) => stop());
    };
  }, [active]);
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Each search from the capture box remounts Notes with its query.
  const [notes, setNotes] = useState({ query: "", visit: 0 });
  // "Start over" in My week shows the setup questions again.
  const [rebuild, setRebuild] = useState(false);
  // The date Plan → Day shows; a Next 7 days column opens it on its date.
  const [day, setDay] = useState(() => logicalDate(systemClock.now()));
  useCalendarSync();
  usePlanHealing(screen !== "loading" && screen !== "setup");

  // The native title bar follows the theme (Rust paints it on open too).
  useEffect(() => {
    const paint = () =>
      void invoke("title_bar", { theme: document.documentElement.dataset.theme ?? "night" }).catch(
        () => undefined,
      );
    window.addEventListener(THEME_EVENT, paint);
    return () => window.removeEventListener(THEME_EVENT, paint);
  }, []);

  // The cached look is applied before the first paint; the settings confirm it.
  useEffect(() => {
    query<{ key: string; value_json: string }>(LOOK_SQL)
      .then((rows) => {
        const get = (key: string) => rows.find((row) => row.key === key)?.value_json;
        applyTheme(themeFromSetting(get("ui.theme")));
      })
      .catch(() => undefined);
  }, []);

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
  const openDay = (date: string) => {
    setDay(date);
    go("day");
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
  else if (screen === "money") page = <Money />;
  else if (screen === "projects") page = <Projects />;
  else if (screen === "tasks") page = <Tasks />;
  else if (screen === "weekcard") page = <WeekCard onOpenDay={openDay} />;
  else if (screen === "day") page = <DayPlan date={day} onDate={setDay} />;
  else if (screen === "dashboard") page = <Dashboard />;
  else if (screen === "notes")
    page = <Notes key={notes.visit} initialQuery={notes.query} onClose={home} />;
  else page = <Today onOpenMoney={() => go("money")} onOpenPlan={() => go("weekcard")} />;
  return (
    <div className="app-shell">
      <Nav current={screen} onGo={go} />
      {/* Keyed by page, so each page opens at the top. */}
      <div className="app-page" key={screen}>
        {isPlanPage(screen) && <PlanTabs current={screen} onGo={go} />}
        {page}
      </div>
    </div>
  );
}
