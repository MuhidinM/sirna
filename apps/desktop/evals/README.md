# AI evals (plan §7.6)

| File            | What                                                                                               | Checked by                                             |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `timing.jsonl`  | 20 ideas with fixed fact sheets and the verdict or slot the app must give (hand-checked, T-034)    | `pnpm test` (offline, `src/features/ai/evals.test.ts`) |
| `capture.jsonl` | 60 loose captures the rules leave in the inbox, with the kind a person would pick                  | `pnpm eval:ai` (live)                                  |
| `command.jsonl` | 30 smart-capture lines, English, Amharic or mixed, with the intents in order (T-090)               | `pnpm test` (each goes to the AI) and `pnpm eval:ai`   |
| `ai.eval.ts`    | Asks the model for timing reasons, capture kinds (6 requests of 10) and smart-capture intents (30) | `pnpm eval:ai`                                         |
| `baseline.json` | The pass counts a prompt or model change must not drop below                                       | written by the first live run, or with `EVAL_UPDATE=1` |

Run it with your own key and the model picked in Settings:

```bash
GEMINI_API_KEY=… GEMINI_MODEL=gemini-3.5-flash-lite pnpm eval:ai
```

It sends 46 requests, 7 s apart. A timing reply passes when it parses, fits the schema and every number in it is in the facts; a capture item passes when its kind matches. Without a key the live file is skipped.

**Baseline: not saved yet.** No key was available when T-038 was built; the first live run writes `baseline.json` (and `last-run.json` every run).
