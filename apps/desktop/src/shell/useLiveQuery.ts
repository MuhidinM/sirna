import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import { query, type Row, type SqlValue } from "../kernel/db";

export interface LiveQuery<T> {
  rows: T[];
  error: string | undefined;
  loading: boolean;
}

/**
 * Runs a read query and runs it again whenever Rust reports a data change
 * (the `data-changed` event), so the screen follows captures and tray ticks.
 */
export function useLiveQuery<T extends Row>(sql: string, params: SqlValue[] = []): LiveQuery<T> {
  const [state, setState] = useState<LiveQuery<T>>({ rows: [], error: undefined, loading: true });
  const key = JSON.stringify(params);

  const load = useCallback(() => {
    query<T>(sql, JSON.parse(key) as SqlValue[])
      .then((rows) => setState({ rows, error: undefined, loading: false }))
      .catch((error: unknown) =>
        setState((previous) => ({ ...previous, error: String(error), loading: false })),
      );
  }, [sql, key]);

  useEffect(() => {
    load();
    const unlisten = listen("data-changed", load);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [load]);

  return state;
}
