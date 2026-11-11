# Smoke test

Five minutes in the **installed** build after every `pnpm ship` (tray, toasts and the hotkey only behave correctly there). Note failures as bug issues.

## Every ship

1. **Tray:** the Sirna icon is in the tray (or the ^ overflow). Its tooltip names the capture key, e.g. "Sirna · Ctrl+Alt+J to capture".
2. **Capture:** press the capture key from another app. The box appears and you can type straight away. Enter shows "Saved" and closes it; Escape closes it; clicking elsewhere closes it.
3. **Saved unchanged:** `node scripts/read-captures.mjs` shows the line exactly as typed.
4. **Toast:** tray → Test notification. The toast says "Sirna" (not PowerShell) and has two buttons. "Open Sirna" opens the main window; "Got it" just closes. Both appear in the log as `toast action: …`.
5. **Focus from the tray:** tray → Start focus. The tooltip reads "Focus · … · 25 min left" and counts down; Pause, Resume, Distracted and Stop work from the menu with no window open.
6. **Window:** close the main window; Sirna stays in the tray. Tray → Open Sirna brings it back.
7. **Second launch:** start Sirna from the Start menu while it runs: no second tray icon; the main window opens.
8. **Quit:** tray → Quit. The tray icon and all `sirna.exe` / `msedgewebview2.exe` children are gone.
9. **Memory:** start it again with `--autostart`, wait a minute, run `scripts/measure.ps1`, and add a line to [measurements.md](measurements.md) if it moved.

## After milestones that touch time

- **Sleep:** with a reminder due in 5 minutes, sleep the laptop for 10. On wake, one summary toast (T-017).
- **Reboot:** after a restart Sirna is in the tray without opening a window (autostart, T-018).

## Restore a backup (T-032)

Written when backups exist.

## Where things are

| What    | Path                                                    |
| ------- | ------------------------------------------------------- |
| App     | `%LOCALAPPDATA%\Sirna\sirna.exe`                        |
| Data    | `%APPDATA%\dev.sirna.app\sirna.db`                      |
| Log     | `%LOCALAPPDATA%\dev.sirna.app\logs\Sirna.log`           |
| Secrets | Windows Credential Manager, entries for `dev.sirna.app` |
