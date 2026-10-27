// A small mirror of pi-anchorloop 2.0.0 pi/ttsr.ts: the frontmatter subset, condition
// compiling, scope tokens, and the tool-call match for bash. Keep it in step with that file.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return undefined;
  const data = {};
  let listKey;
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(parseScalar(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`unparseable frontmatter line: ${line}`);
    const [, key, rawValue] = pair;
    const value = rawValue.trim();
    listKey = undefined;
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(parseScalar).filter((v) => v.length > 0);
    } else {
      data[key] = parseScalar(value);
    }
  }
  return { data, body: source.slice(match[0].length) };
}

const toList = (value) => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter((v) => v.length > 0));

export function compileCondition(pattern) {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  if (inline) return new RegExp(pattern.slice(inline[0].length), Array.from(new Set(inline[1])).join(""));
  return new RegExp(pattern);
}

function buildScope(tokens) {
  if (tokens.length === 0) return { allowText: true, allowThinking: false, allowAnyTool: true, toolScopes: [] };
  const scope = { allowText: false, allowThinking: false, allowAnyTool: false, toolScopes: [] };
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "text") scope.allowText = true;
    else if (normalized === "thinking") scope.allowThinking = true;
    else if (normalized === "tool" || normalized === "toolcall") scope.allowAnyTool = true;
    else {
      const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(token);
      if (!match?.groups) throw new Error(`invalid scope token "${token}"`);
      const { prefix, tool, bare, path } = match.groups;
      const toolName = (tool ?? (prefix ? undefined : bare))?.toLowerCase();
      const pathGlob = path?.trim();
      if (!toolName && !pathGlob) scope.allowAnyTool = true;
      else scope.toolScopes.push({ toolName, pathGlob });
    }
  }
  return scope;
}

/** A rule file as ttsr.ts would load it, plus the fixture lists the profile adds. Throws where ttsr.ts would skip the rule. */
export function loadRule(path) {
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  if (!parsed) throw new Error(`${path}: no frontmatter`);
  const { data, body } = parsed;
  const rawConditions = toList(data.condition);
  if (rawConditions.length === 0) throw new Error(`${path}: no condition`);
  return {
    name: basename(path).replace(/\.mdc?$/, ""),
    content: body,
    conditions: rawConditions.map(compileCondition),
    scope: buildScope(toList(data.scope).flatMap((v) => [v])),
    globs: toList(data.globs),
    repeatMode: data.repeatMode === "after-gap" ? "after-gap" : "once",
    blocks: toList(data.blocks),
    allows: toList(data.allows),
    data,
  };
}

function inScope(rule, source, toolName) {
  if (rule.globs.length > 0) return false; // the profile's rules have no path globs
  if (source === "text") return rule.scope.allowText;
  if (source === "thinking") return false;
  if (rule.scope.allowAnyTool) return true;
  const name = toolName?.toLowerCase();
  return rule.scope.toolScopes.some((s) => (!s.toolName || s.toolName === name) && !s.pathGlob);
}

/** Whether the rule blocks a call of `toolName` whose matched text is `digest` (the command, for bash). */
export function blocksToolCall(rule, toolName, digest) {
  return inScope(rule, "tool", toolName) && rule.conditions.some((c) => ((c.lastIndex = 0), c.test(digest)));
}
