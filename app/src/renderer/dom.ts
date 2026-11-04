// A tiny DOM builder for the shell pages: elements are made with `h`, text goes in as text nodes (never as HTML), and handlers are `on<event>` attributes. No framework, and never markup from a string.

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (typeof value === "function") el.addEventListener(name.slice(2), value);
		else if (value === true) el.setAttribute(name, "");
		else el.setAttribute(name, String(value));
	}
	append(el, children);
	return el;
}

export function append(parent: Node, children: readonly Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

export const clear = (el: Element): void => el.replaceChildren();

/**
 * The values of the password fields under `root`, by id. A page that redraws a whole step calls this before it clears the step and `restorePasswords` after, so a token being typed is not lost to a
 * redraw. The map lives in the caller's local variable for the length of one synchronous redraw; nothing here stores it.
 */
export function carryPasswords(root: Element): Map<string, string> {
	const held = new Map<string, string>();
	for (const input of root.querySelectorAll<HTMLInputElement>('input[type="password"]')) if (input.id !== "" && input.value !== "") held.set(input.id, input.value);
	return held;
}

export function restorePasswords(root: Element, held: ReadonlyMap<string, string>): void {
	for (const [id, value] of held) {
		const input = root.querySelector<HTMLInputElement>(`input[type="password"]#${CSS.escape(id)}`);
		if (input !== null) input.value = value;
	}
}
