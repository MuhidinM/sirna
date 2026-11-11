import { useEffect, useState } from "react";

import { query } from "./kernel/db";
import { SETUP_DONE_KEY } from "./features/plan/setup";
import { Setup } from "./shell/Setup";
import { Today } from "./shell/Today";

type Screen = "loading" | "setup" | "today";

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");

  useEffect(() => {
    query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
      SETUP_DONE_KEY,
    ])
      .then(([row]) => setScreen(row?.value_json === "true" ? "today" : "setup"))
      .catch(() => setScreen("today"));
  }, []);

  if (screen === "loading") return null;
  if (screen === "setup") return <Setup onDone={() => setScreen("today")} />;
  return <Today onChangeWeek={() => setScreen("setup")} />;
}
