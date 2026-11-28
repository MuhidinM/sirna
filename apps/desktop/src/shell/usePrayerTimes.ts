import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { type PrayerTimes } from "../features/prayer/prayer";

/**
 * A day's prayer times from Rust (`prayer_times`, T-092), worked out again
 * when settings change (the city from the tray or a capture, or Settings).
 * Null until they arrive, or when Rust can't give them.
 */
export function usePrayerTimes(date: string): PrayerTimes | null {
  const [times, setTimes] = useState<PrayerTimes | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      invoke<PrayerTimes>("prayer_times", { date })
        .then((next) => {
          if (live) setTimes(next);
        })
        .catch(() => {
          if (live) setTimes(null);
        });
    };
    load();
    const unlisten = listen<string[] | null>("data-changed", (event) => {
      const tables = event.payload;
      if (!Array.isArray(tables) || tables.includes("core_settings")) load();
    });
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
  }, [date]);
  return times;
}
