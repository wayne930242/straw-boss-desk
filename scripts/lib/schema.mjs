// A small JSON Schema checker for stack.schema.json. It supports only the keywords that file uses and throws on any other,
// so a schema keyword that this checker would silently ignore can never be added by accident.
const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description"]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(want, value) {
  const got = typeOf(value);
  return got === want || (want === "number" && got === "integer");
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
  }
  return node;
}

function check(root, schema, value, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case "$ref":
        check(root, resolve(root, schema.$ref), value, path, errors);
        break;
      case "type":
        if (!typeMatches(schema.type, value)) errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
        break;
      case "const":
        if (value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
        break;
      case "enum":
        if (!schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
        break;
      case "pattern":
        if (typeof value === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
        break;
      case "minLength":
        if (typeof value === "string" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
        break;
      case "minimum":
        if (typeof value === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
        break;
      case "minItems":
        if (Array.isArray(value) && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
        break;
      case "items":
        if (Array.isArray(value)) value.forEach((item, i) => check(root, schema.items, item, `${path}[${i}]`, errors));
        break;
      case "required":
        if (typeOf(value) === "object") {
          for (const key of schema.required) if (!(key in value)) errors.push(`${path}: missing ${key}`);
        }
        break;
      case "properties":
        if (typeOf(value) === "object") {
          for (const [key, sub] of Object.entries(schema.properties)) if (key in value) check(root, sub, value[key], `${path}.${key}`, errors);
        }
        break;
      case "additionalProperties":
        if (typeOf(value) === "object") {
          const known = schema.properties ?? {};
          for (const key of Object.keys(value)) {
            if (key in known) continue;
            if (schema.additionalProperties === false) errors.push(`${path}: unknown key ${key}`);
            else check(root, schema.additionalProperties, value[key], `${path}.${key}`, errors);
          }
        }
        break;
      default:
        throw new Error(`stack.schema.json uses the keyword "${keyword}", which scripts/lib/schema.mjs does not check`);
    }
  }
}

/** Returns the list of violations (empty when `value` satisfies `schema`), each starting with the path of the value. */
export function validate(schema, value) {
  const errors = [];
  check(schema, schema, value, "$", errors);
  return errors;
}
