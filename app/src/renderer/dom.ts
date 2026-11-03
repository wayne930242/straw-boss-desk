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
