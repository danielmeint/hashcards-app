import cardSchema from "../schema/card.schema.json" with { type: "json" };

/**
 * Validation against `schema/card.schema.json`, so that `hc add --json` and
 * the schema agents are given can never disagree: the schema file is the
 * rules, and this walks it.
 *
 * Only the keywords that schema uses are implemented — `type`, `required`,
 * `properties`, `additionalProperties: false`, `enum`, `const`, `pattern`,
 * `items`, `uniqueItems`, `allOf`, `if`/`then`, `not` and local `$ref`. An
 * unknown keyword is an error here rather than silently ignored, so a schema
 * change this cannot follow fails the tests instead of letting cards through.
 */

type Schema = {
  [keyword: string]: unknown;
};

export type SchemaError = {
  /** JSON Pointer into the value, `""` for the root. */
  path: string;
  message: string;
};

const KNOWN = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "examples",
  "default",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "items",
  "uniqueItems",
  "allOf",
  "if",
  "then",
  "not",
]);

export const CARD_SCHEMA = cardSchema as unknown as Schema;

export function validateCard(value: unknown): SchemaError[] {
  return validate(CARD_SCHEMA, value, CARD_SCHEMA);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

/**
 * The nearest description, to explain a failed pattern: a regex in an error
 * message helps nobody. Inherited, because the patterns that fail are often in
 * an `allOf` under the schema that says what they mean.
 */
function hintOf(schema: Schema, inherited: string): string {
  return typeof schema.description === "string" ? schema.description : inherited;
}

export function validate(
  schema: Schema,
  value: unknown,
  root: Schema,
  path = "",
  inheritedHint = ""
): SchemaError[] {
  const errors: SchemaError[] = [];
  const hint = hintOf(schema, inheritedHint);
  const fail = (message: string, at = path) => errors.push({ path: at, message });

  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`card schema uses '${keyword}', which hc cannot check`);
  }

  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    errors.push(...validate(target, value, root, path, hintOf(target, hint)));
  }

  if (typeof schema.type === "string") {
    const actual = typeOf(value);
    const ok = schema.type === actual || (schema.type === "number" && actual === "integer");
    if (!ok) {
      fail(`must be ${article(schema.type)}, got ${actual}`);
      return errors; // Nothing else can be checked meaningfully.
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`);
  }
  if ("const" in schema && value !== schema.const) {
    fail(`must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (typeof schema.pattern === "string" && typeof value === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      fail(`is not valid: ${JSON.stringify(value)}${hint ? `. ${hint}` : ""}`);
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) fail(`is missing "${key}"`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(sub, obj[key], root, `${path}/${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          fail(`has unknown property "${key}" (allowed: ${Object.keys(props).join(", ")})`);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(schema.items as Schema, item, root, `${path}/${i}`, hint)));
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) fail("must not repeat an item");
    }
  }

  for (const sub of (schema.allOf as Schema[] | undefined) ?? []) {
    errors.push(...validate(sub, value, root, path, hint));
  }

  if (schema.if) {
    const applies = validate(schema.if as Schema, value, root, path).length === 0;
    if (applies && schema.then) errors.push(...validate(schema.then as Schema, value, root, path));
  }

  if (schema.not) {
    const not = schema.not as Schema;
    if (validate(not, value, root, path).length === 0) {
      // The schema only ever says "not required: [x]" — say that plainly.
      const req = not.required as string[] | undefined;
      if (req && Object.keys(not).length === 1) {
        const kind = (value as { type?: string }).type;
        fail(`must not have ${req.map((r) => `"${r}"`).join(", ")}${kind ? ` on a ${kind} card` : ""}`);
      } else fail(`must not match ${JSON.stringify(not)}`);
    }
  }

  return errors;
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`card schema has a non-local $ref '${ref}'`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)[part];
  if (!node) throw new Error(`card schema $ref '${ref}' points nowhere`);
  return node as Schema;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
