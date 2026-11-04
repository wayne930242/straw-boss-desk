// A very small DOM for the renderer tests: enough of `document`, elements and text nodes for `h()` and the pages' draw functions to run under plain Node, and `querySelectorAll` for the selectors the
// tests and `dom.ts` use (a tag, `.class`, `[attr]`, `[attr="value"]`, `#id`, joined, and descendants separated by a space). Test code only; it is not a browser, and anything a page does that it
// does not model (layout, focus, events that bubble) is for the e2e run to prove.

export class MiniText {
	nodeType = 3;
	parentNode: MiniElement | null = null;
	data: string;
	constructor(data: string) {
		this.data = data;
	}
	get textContent(): string {
		return this.data;
	}
}

type Listener = (event: unknown) => void;

export class MiniElement {
	nodeType = 1;
	parentNode: MiniElement | null = null;
	childNodes: Array<MiniElement | MiniText> = [];
	value = "";
	readonly #attrs = new Map<string, string>();
	readonly #listeners = new Map<string, Listener[]>();
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}

	setAttribute(name: string, value: string): void {
		this.#attrs.set(name, value);
		if (name === "value") this.value = value;
	}
	getAttribute(name: string): string | null {
		return this.#attrs.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.#attrs.has(name);
	}
	get id(): string {
		return this.#attrs.get("id") ?? "";
	}
	get className(): string {
		return this.#attrs.get("class") ?? "";
	}
	appendChild<T extends MiniElement | MiniText>(child: T): T {
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}
	append(...children: Array<MiniElement | MiniText | string>): void {
		for (const c of children) this.appendChild(typeof c === "string" ? new MiniText(c) : c);
	}
	replaceChildren(...children: Array<MiniElement | MiniText>): void {
		for (const c of this.childNodes) c.parentNode = null;
		this.childNodes = [];
		for (const c of children) this.appendChild(c);
	}
	addEventListener(type: string, listener: Listener): void {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
	}
	/** Runs the handlers of `type` with `event`. */
	fire(type: string, event: unknown = {}): void {
		for (const l of this.#listeners.get(type) ?? []) l(event);
	}
	get children(): MiniElement[] {
		return this.childNodes.filter((c): c is MiniElement => c instanceof MiniElement);
	}
	get textContent(): string {
		return this.childNodes.map((c) => c.textContent).join("");
	}
	get disabled(): boolean {
		return this.#attrs.has("disabled");
	}
	querySelectorAll<T = MiniElement>(selector: string): T[] {
		const parts = selector.trim().split(/\s+/);
		const last = parts[parts.length - 1] as string;
		const out: MiniElement[] = [];
		const visit = (el: MiniElement, trail: readonly MiniElement[]): void => {
			for (const child of el.children) {
				if (matches(child, last) && ancestorsMatch(trail, parts.slice(0, -1))) out.push(child);
				visit(child, [...trail, child]);
			}
		};
		visit(this, []);
		return out as T[];
	}
	querySelector<T = MiniElement>(selector: string): T | null {
		return this.querySelectorAll<T>(selector)[0] ?? null;
	}
}

/** Whether `wanted` (outermost first) appears in order along `trail` (outermost first): the descendant combinator. */
function ancestorsMatch(trail: readonly MiniElement[], wanted: readonly string[]): boolean {
	let at = 0;
	for (const simple of wanted) {
		while (at < trail.length && !matches(trail[at] as MiniElement, simple)) at++;
		if (at === trail.length) return false;
		at++;
	}
	return true;
}

function matches(el: MiniElement, simple: string): boolean {
	let rest = simple;
	const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest)?.[0];
	if (tag !== undefined) {
		if (el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
		rest = rest.slice(tag.length);
	}
	while (rest.length > 0) {
		let m: RegExpExecArray | null;
		if ((m = /^\.([\w-]+)/.exec(rest))) {
			if (!el.className.split(/\s+/).includes(m[1] as string)) return false;
		} else if ((m = /^#([\w-]+)/.exec(rest))) {
			if (el.id !== m[1]) return false;
		} else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
			const v = el.getAttribute(m[1] as string);
			if (v === null || (m[2] !== undefined && v !== m[2])) return false;
		} else throw new Error(`mini-dom: unsupported selector ${simple}`);
		rest = rest.slice(m[0].length);
	}
	return true;
}

/** Installs a `document` that makes these elements, and returns what undoes it. */
export function installMiniDom(): () => void {
	const g = globalThis as unknown as { document?: unknown };
	const before = g.document;
	g.document = {
		createElement: (tag: string) => new MiniElement(tag),
		createTextNode: (text: string) => new MiniText(text),
	};
	return () => {
		if (before === undefined) delete g.document;
		else g.document = before;
	};
}
