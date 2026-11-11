# 0009 — Our own small schema module instead of zod

Status: accepted · 2026-11-11

## Context

Plan §7.2 said "zod → flat JSON Schema", with every reply re-checked by zod. Two things changed the picture at M4 (T-037):

- Gemini's structured output accepts only a documented subset of JSON Schema (Appendix C). zod's own `toJSONSchema()` emits keywords outside it (`$schema`, `additionalProperties`, length and pattern limits), so its output would need stripping anyway; Google's forum reports the same.
- The replies Sirna needs are small: a few strings, numbers, enums and short lists.

## Decision

`features/ai/schema.ts` (about 150 lines, no dependency) defines a schema once and gives both:

- the JSON Schema sent to the model, using only `type`, `properties`, `required`, `enum`, `items` and `description`;
- the check every reply must pass: types, enums, required fields, and the limits Gemini isn't sent (max items, max length, number ranges). Unknown properties are dropped, never passed on.

The Gemini adapter sends the schema as `generationConfig.responseJsonSchema` with `responseMimeType: application/json`. The schema is also in the prompt, and if Google rejects the field with a 400 the adapter stops sending it for the session; the local check applies either way.

## Consequences

- No zod in the bundle (plan §10: small on the machine), and the sent schema can't drift from what Gemini documents.
- Anything richer (unions, refinements) would need adding by hand; the AI touchpoints in §7.3 don't need it.
