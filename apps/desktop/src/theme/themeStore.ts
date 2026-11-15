import { transact } from "../kernel/db";
import { applyTheme, THEME_EVENT, type Theme } from "./theme";

export { THEME_EVENT, type Theme };

/** Shows the theme at once and saves it (the rail switch and Settings). */
export function transactTheme(theme: Theme): Promise<unknown> {
  applyTheme(theme);
  return transact(
    "user",
    [
      {
        op: "upsert",
        table: "core_settings",
        id: "ui.theme",
        values: { value_json: JSON.stringify(theme) },
      },
    ],
    "settings",
  );
}
