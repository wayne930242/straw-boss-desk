(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const btn = [...document.querySelectorAll("button, [role=button], a, div")].find((e) => e.children.length === 0 && /new base/i.test(e.textContent || ""));
	if (!btn) return { error: "no new-base button", text: document.body.innerText.slice(0, 500) };
	btn.click();
	await sleep(2000);
	return { text: document.body.innerText.slice(0, 1500), inputs: [...document.querySelectorAll("input,textarea,select,button")].map((e) => `${e.tagName}:${e.type || ""}:${e.placeholder || e.textContent.trim().slice(0, 30)}`) };
})()
