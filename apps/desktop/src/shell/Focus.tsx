import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { Button, Card } from "./ui";

export interface FocusStatus {
  kind: "focus" | "break" | "long_break" | null;
  title: string;
  remaining_ms: number;
  planned_min: number;
  paused: boolean;
  in_row: number;
  block_id: string | null;
}

/** The timer's state from Rust, counted down locally once a second between updates. */
export function useFocus(): FocusStatus | undefined {
  const [status, setStatus] = useState<FocusStatus>();

  useEffect(() => {
    let base: FocusStatus | undefined;
    let shownAt = 0;
    const load = () =>
      void invoke<FocusStatus>("focus_status").then((next) => {
        base = next;
        shownAt = performance.now();
        setStatus(next);
      });
    load();
    const stops = [listen("focus-changed", load), listen("focus-tick", load)];
    const second = setInterval(() => {
      if (!base || base.kind === null || base.paused) return;
      const remaining = Math.max(0, base.remaining_ms - (performance.now() - shownAt));
      setStatus({ ...base, remaining_ms: remaining });
    }, 1000);
    return () => {
      clearInterval(second);
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, []);

  return status;
}

export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Starts focus on a block; asks again during a long break or past the hard stop. */
export async function startFocus(blockId: string | null): Promise<void> {
  const result = await invoke<string>("focus_start", { blockId, force: false });
  const ask =
    result === "confirm"
      ? "You're on a long break. Start focus anyway?"
      : result === "confirm-stop"
        ? "It's past your hard stop. Start anyway?"
        : undefined;
  if (ask && window.confirm(ask)) await invoke("focus_start", { blockId, force: true });
}

const control = (action: "pause" | "resume" | "stop" | "distracted") =>
  void invoke("focus_control", { action });

export function FocusPanel({ status }: { status: FocusStatus }) {
  if (status.kind === null) return null;
  const onBreak = status.kind !== "focus";
  const label = status.kind === "long_break" ? "Long break" : onBreak ? "Break" : "Focus";
  return (
    <Card className={onBreak ? "focus-panel break" : "focus-panel"}>
      <div className="focus-head">
        <div>
          <p className="meta">
            {label}
            {status.title && status.title !== label ? ` · ${status.title}` : ""}
            {status.in_row > 0 && !onBreak ? ` · session ${status.in_row + 1}` : ""}
          </p>
          <p className="focus-clock" aria-live="off">
            {clock(status.remaining_ms)}
            {status.paused ? " · paused" : ""}
          </p>
        </div>
        <div className="focus-actions">
          {!onBreak &&
            (status.paused ? (
              <Button onClick={() => control("resume")}>Resume</Button>
            ) : (
              <Button onClick={() => control("pause")}>Pause</Button>
            ))}
          {!onBreak && <Button onClick={() => control("distracted")}>Distracted</Button>}
          <Button onClick={() => control("stop")}>{onBreak ? "End break" : "Stop"}</Button>
        </div>
      </div>
      {onBreak && <p className="meta">Stand up, drink water, look away from the screen.</p>}
    </Card>
  );
}
