import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { query } from "./kernel/db";
import { SETUP_DONE_KEY } from "./features/plan/setup";
import { Kits } from "./shell/Kits";
import { Review } from "./shell/Review";
import { Setup } from "./shell/Setup";
import { Today } from "./shell/Today";

type Screen = "loading" | "setup" | "today" | "review" | "kits";

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");

  useEffect(() => {
    Promise.all([
      query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
        SETUP_DONE_KEY,
      ]),
      // The tray or a toast may have opened the window for the review.
      invoke<string | null>("take_screen").catch(() => null),
    ])
      .then(([[row], pending]) => {
        if (row?.value_json !== "true") setScreen("setup");
        else setScreen(pending === "review" ? "review" : "today");
      })
      .catch(() => setScreen("today"));

    const unlisten = listen<string>("show-screen", (event) => {
      void invoke("take_screen").catch(() => null);
      if (event.payload === "review") setScreen("review");
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  if (screen === "loading") return null;
  if (screen === "setup") return <Setup onDone={() => setScreen("today")} />;
  if (screen === "review") return <Review onClose={() => setScreen("today")} />;
  if (screen === "kits") return <Kits onClose={() => setScreen("today")} />;
  return (
    <Today
      onChangeWeek={() => setScreen("setup")}
      onReview={() => setScreen("review")}
      onKits={() => setScreen("kits")}
    />
  );
}
