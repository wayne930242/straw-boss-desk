// The helper-output guard (T5-F008, R5-F004, T6-F008): a credential helper's output must never reach an assertion's message or arguments, because node's
// `assert` prints `actual` when it fails, and the output may be a token. A test may only ask a question of it (`.includes(...)`), which hands `assert` a boolean.
//
// The guard reads a test file statement by statement, not line by line, so an assertion that spans lines is one statement. It follows an alias
// (`const out = filled.stdout;`, `const { stdout } = filled;`) to the statements that use it, and it treats `t.diagnostic(...)`, `console.*(...)`,
// `throw`, `new Error(...)`, and a bare `assert(...)` as sinks beside `assert.<method>(...)`. The tokenizer is small and meant for this repository's test
// files (strings, template literals, comments, and regular-expression literals are skipped over; braces are told apart as blocks and objects by what
// precedes them); `bootstrap-t5-fixes.test.ts` runs it over every test file and plants each form into a copy of the real `e2e-light.test.ts`.

export interface Statement {
	/** 1-based line where the statement starts. */
	line: number;
	text: string;
	/** The ids of the blocks that enclose the statement, outermost first: a name bound in a statement is visible to statements whose scope starts with its own. */
	scope: readonly number[];
}

const OUTPUT_SOURCE = String.raw`\b(?:filled|credential)\w*\.(?:stdout|stderr)\b`;
const SINK = /\bassert(?:\.\w+)?\s*\(|\.diagnostic\s*\(|\bconsole\.\w+\s*\(|\bthrow\b|\bnew\s+Error\s*\(/;

/** Characters after which a `/` starts a regular-expression literal rather than a division. */
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** The statements of `source`, comments dropped and the content of ordinary string literals blanked (template literals keep their `${...}` text). */
export function statementsOf(source: string): Statement[] {
	const out: Statement[] = [];
	let buffer = "";
	let startLine = 1;
	let line = 1;
	const stack: Array<"p" | "b"> = [];
	/** The block ids on the stack, outermost first. */
	const blocks: number[] = [];
	let nextBlock = 1;
	const flush = (): void => {
		const text = buffer.trim();
		if (text !== "") out.push({ line: startLine, text, scope: [...blocks] });
		buffer = "";
	};
	const append = (text: string): void => {
		if (buffer.trim() === "") startLine = line;
		buffer += text;
	};
	const atBlock = (): boolean => stack.length === 0 || stack[stack.length - 1] === "b";
	const lastSignificant = (): string => buffer.trimEnd().slice(-1);
	const continues = (rest: string): boolean => {
		const tail = buffer.trimEnd();
		if (/(?:,|\+|&&|\|\||\?|:|=|=>|\.|\(|\[|\{)$/.test(tail)) return true;
		return /^\s*(?:\.|\?|:|&&|\|\||\+|,|\))/.test(rest);
	};

	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			line += source.slice(i, stop).split("\n").length - 1;
			i = stop;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
			append(`${c}${c}`);
			i = j + 1;
			continue;
		}
		if (c === "`") {
			const end = skipTemplate(source, i);
			const text = source.slice(i, end);
			append(text);
			line += text.split("\n").length - 1;
			i = end;
			continue;
		}
		if (c === "/" && (buffer.trim() === "" || REGEX_AFTER.has(lastSignificant()))) {
			append("/re/");
			i = skipRegex(source, i);
			continue;
		}
		if (c === "(" || c === "[") {
			stack.push("p");
			append(c);
			i++;
			continue;
		}
		if (c === ")" || c === "]") {
			stack.pop();
			append(c);
			i++;
			continue;
		}
		if (c === "{") {
			const tail = buffer.trimEnd();
			const block = tail === "" || /(?:=>|\)|\belse|\btry|\bfinally|\bdo|;)$/.test(tail) || /\)\s*:\s*[\w.<>[\]|, ]+$/.test(tail);
			if (block) {
				append(c);
				flush();
				stack.push("b");
				blocks.push(nextBlock++);
			} else {
				stack.push("p");
				append(c);
			}
			i++;
			continue;
		}
		if (c === "}") {
			const top = stack.pop();
			if (top === "b") {
				flush();
				blocks.pop();
			} else append(c);
			i++;
			continue;
		}
		if (c === ";") {
			if (atBlock()) {
				append(c);
				flush();
			} else append(c);
			i++;
			continue;
		}
		if (c === "\n") {
			line++;
			if (atBlock() && buffer.trim() !== "" && !continues(source.slice(i + 1))) flush();
			else append(" ");
			i++;
			continue;
		}
		append(c);
		i++;
	}
	flush();
	return out;
}

/** The index after the regular-expression literal that starts at `start` (a slash): up to the closing slash outside a character class, then its flags. */
function skipRegex(source: string, start: number): number {
	let j = start + 1;
	let inClass = false;
	while (j < source.length && source[j] !== "\n") {
		const d = source[j] as string;
		if (d === "\\") j += 2;
		else if (d === "[") { inClass = true; j++; }
		else if (d === "]") { inClass = false; j++; }
		else if (d === "/" && !inClass) break;
		else j++;
	}
	j++;
	while (j < source.length && /[a-z]/i.test(source[j] as string)) j++;
	return j;
}

/** The index after the template literal that starts at `start` (a backtick), nested `${...}` expressions and their own templates included. */
function skipTemplate(source: string, start: number): number {
	let i = start + 1;
	while (i < source.length) {
		const c = source[i];
		if (c === "\\") i += 2;
		else if (c === "`") return i + 1;
		else if (c === "$" && source[i + 1] === "{") i = skipExpression(source, i + 2);
		else i++;
	}
	return i;
}

/** The index after the `}` that closes a `${` expression whose first character is at `start`. */
function skipExpression(source: string, start: number): number {
	let depth = 1;
	let i = start;
	let previous = "(";
	while (i < source.length && depth > 0) {
		const c = source[i];
		if (c === "/" && REGEX_AFTER.has(previous) && source[i + 1] !== "/" && source[i + 1] !== "*") {
			i = skipRegex(source, i);
			previous = "x";
		} else if (c === "`") {
			i = skipTemplate(source, i);
			previous = "x";
		} else if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
			i = j + 1;
			previous = "x";
		} else {
			if (c === "{") depth++;
			else if (c === "}") depth--;
			if (c !== " " && c !== "\t" && c !== "\n") previous = c as string;
			i++;
		}
	}
	return i;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Binding {
	name: string;
	scope: readonly number[];
}

/** True when `outer` is a prefix of `inner`: a name bound in a statement of scope `outer` is visible in a statement of scope `inner`. */
const visibleIn = (outer: readonly number[], inner: readonly number[]): boolean => outer.length <= inner.length && outer.every((id, i) => inner[i] === id);

const namesVisible = (bindings: readonly Binding[], scope: readonly number[]): string[] => [...new Set(bindings.filter((b) => visibleIn(b.scope, scope)).map((b) => b.name))];

const aliasPattern = (names: readonly string[]): string => (names.length === 0 ? "(?!)" : `(?<![.\\w])(?:${names.map(escapeRe).join("|")})\\b`);

const askedPattern = (names: readonly string[]): RegExp => new RegExp(`(?:${OUTPUT_SOURCE}|${aliasPattern(names)})\\.includes\\(`, "g");

/** The names the statements bind to a helper's output: `const x = filled.stdout...`, `const { stdout } = filled`, and a binding made from another alias, each with its scope. */
function bindingsOf(statements: readonly Statement[]): Binding[] {
	const bindings: Binding[] = [];
	const output = new RegExp(OUTPUT_SOURCE);
	const known = (name: string, scope: readonly number[]): boolean => bindings.some((b) => b.name === name && b.scope.join() === scope.join());
	for (let pass = 0; pass < 4; pass++) {
		let grew = false;
		for (const { text, scope } of statements) {
			const destructured = /^(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:filled|credential)\w*\b/.exec(text);
			if (destructured?.[1] !== undefined) {
				for (const part of destructured[1].split(",")) {
					const m = /^\s*(stdout|stderr)\s*(?::\s*(\w+))?\s*$/.exec(part);
					const name = m?.[2] ?? m?.[1];
					if (name !== undefined && !known(name, scope)) { bindings.push({ name, scope }); grew = true; }
				}
				continue;
			}
			const bound = /^(?:(?:const|let|var)\s+)?(\w+)\s*(?::[^=]+)?=(?!=)\s*([\s\S]*)$/.exec(text);
			if (bound?.[1] === undefined || bound[2] === undefined || known(bound[1], scope)) continue;
			const visible = namesVisible(bindings, scope);
			const rhs = bound[2].replace(askedPattern(visible), "");
			if (output.test(rhs) || new RegExp(aliasPattern(visible)).test(rhs)) { bindings.push({ name: bound[1], scope }); grew = true; }
		}
		if (!grew) break;
	}
	return bindings;
}

/**
 * The statements of `source` in which a credential helper's `stdout` or `stderr`, or an alias of it, reaches an assertion, `t.diagnostic`, `console.*`, a
 * `throw`, or an `Error`, except where it is only asked a question with `.includes(...)`.
 */
export function echoingStatements(source: string): Statement[] {
	const statements = statementsOf(source);
	const bindings = bindingsOf(statements);
	return statements.filter(({ text, scope }) => {
		if (!SINK.test(text)) return false;
		const visible = namesVisible(bindings, scope);
		const used = new RegExp(`${OUTPUT_SOURCE}|${aliasPattern(visible)}`);
		return used.test(text.replace(askedPattern(visible), "("));
	});
}
