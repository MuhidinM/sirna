/** Why the AI couldn't help, in words (codes from ai.rs and task.ts). */
export function aiUnavailable(code: string): string {
  if (code === "no-key") return "No Gemini key yet (Settings → Keys and links).";
  if (code === "bad-model") return "Pick a model in Settings → AI.";
  if (code.startsWith("budget")) return "Today's AI limit is used up.";
  if (code.startsWith("rate-limited") || code.startsWith("plain-mode"))
    return "The AI is resting for a few minutes.";
  if (code.startsWith("network")) return "Couldn't reach the AI.";
  return "The AI's answer didn't check out, so it was left out.";
}
