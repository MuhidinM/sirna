/**
 * Output schemas for AI tasks (plan §7.2). One small definition gives both
 * the flat JSON Schema sent to the model (only type, properties, required,
 * enum, items, description: the keywords Gemini documents) and the check
 * every reply must pass before it is used. Limits Gemini doesn't take
 * (max items, max length) are enforced here, never sent.
 */

export type Schema =
  | { kind: "string"; maxLength?: number; description?: string }
  | { kind: "number"; min?: number; max?: number; description?: string }
  | { kind: "integer"; min?: number; max?: number; description?: string }
  | { kind: "boolean"; description?: string }
  | { kind: "enum"; values: readonly string[]; description?: string }
  | { kind: "array"; items: Schema; maxItems?: number; description?: string }
  | {
      kind: "object";
      properties: Record<string, Schema>;
      required: readonly string[];
      description?: string;
    };

export const s = {
  string: (options: { maxLength?: number; description?: string } = {}): Schema => ({
    kind: "string",
    ...options,
  }),
  number: (options: { min?: number; max?: number; description?: string } = {}): Schema => ({
    kind: "number",
    ...options,
  }),
  integer: (options: { min?: number; max?: number; description?: string } = {}): Schema => ({
    kind: "integer",
    ...options,
  }),
  boolean: (description?: string): Schema => ({
    kind: "boolean",
    ...(description ? { description } : {}),
  }),
  enum: (values: readonly string[], description?: string): Schema => ({
    kind: "enum",
    values,
    ...(description ? { description } : {}),
  }),
  array: (items: Schema, options: { maxItems?: number; description?: string } = {}): Schema => ({
    kind: "array",
    items,
    ...options,
  }),
  /** Every property is required unless listed in `optional`. */
  object: (
    properties: Record<string, Schema>,
    optional: readonly string[] = [],
    description?: string,
  ): Schema => ({
    kind: "object",
    properties,
    required: Object.keys(properties).filter((name) => !optional.includes(name)),
    ...(description ? { description } : {}),
  }),
};

export type JsonSchema = Record<string, unknown>;

/** The flat JSON Schema for the model: documented keywords only. */
export function toJsonSchema(schema: Schema): JsonSchema {
  const described = (value: JsonSchema): JsonSchema =>
    schema.description ? { ...value, description: schema.description } : value;
  switch (schema.kind) {
    case "string":
      return described({ type: "string" });
    case "number":
      return described({ type: "number" });
    case "integer":
      return described({ type: "integer" });
    case "boolean":
      return described({ type: "boolean" });
    case "enum":
      return described({ type: "string", enum: [...schema.values] });
    case "array":
      return described({ type: "array", items: toJsonSchema(schema.items) });
    case "object":
      return described({
        type: "object",
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([name, value]) => [name, toJsonSchema(value)]),
        ),
        required: [...schema.required],
      });
  }
}

export type Checked = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Checks a parsed reply against the schema. Unknown properties are dropped,
 * never passed on; anything missing, mistyped or over a limit fails.
 */
export function check(schema: Schema, value: unknown, path = "reply"): Checked {
  const fail = (error: string): Checked => ({ ok: false, error: `${path}: ${error}` });
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") return fail("not text");
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return fail(`longer than ${schema.maxLength}`);
      return { ok: true, value: value.trim() };
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("not a number");
      if (schema.kind === "integer" && !Number.isInteger(value)) return fail("not a whole number");
      if (schema.min !== undefined && value < schema.min) return fail(`below ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return fail(`above ${schema.max}`);
      return { ok: true, value };
    }
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : fail("not true or false");
    case "enum":
      return typeof value === "string" && schema.values.includes(value)
        ? { ok: true, value }
        : fail(`not one of ${schema.values.join(", ")}`);
    case "array": {
      if (!Array.isArray(value)) return fail("not a list");
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return fail(`more than ${schema.maxItems} items`);
      const items: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const result = check(schema.items, item, `${path}[${index}]`);
        if (!result.ok) return result;
        items.push(result.value);
      }
      return { ok: true, value: items };
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return fail("not an object");
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(schema.properties)) {
        if (record[name] === undefined || record[name] === null) {
          if (schema.required.includes(name)) return fail(`missing ${name}`);
          continue;
        }
        const result = check(property, record[name], `${path}.${name}`);
        if (!result.ok) return result;
        out[name] = result.value;
      }
      return { ok: true, value: out };
    }
  }
}

/** Parses the model's text (sometimes wrapped in a ```json fence) and checks it. */
export function parseReply(schema: Schema, text: string): Checked {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return { ok: false, error: "reply: not JSON" };
  }
  return check(schema, parsed);
}
