(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const find = (re, sel = "button, a, [role=button], div, span") => [...document.querySelectorAll(sel)].find((e) => e.children.length < 3 && re.test((e.textContent || "").trim()));
	const hit = async (re) => {
		const e = find(re);
		if (!e) throw new Error(`nothing matches ${re}; page: ${document.body.innerText.slice(0, 300)}`);
		e.click();
		await sleep(1500);
	};
	await hit(/^demo-base$/i);
	const link = [...document.querySelectorAll("a[href]")].find((a) => /\/s\//.test(a.getAttribute("href")));
	if (!link) throw new Error(`no unit link; hrefs: ${[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).join(" ")}`);
	link.click();
	await sleep(1500);
	await hit(/^Terminal$/);
	await sleep(4000);
	const term = document.querySelector(".xterm, [class*=terminal], canvas, pre");
	return { terminalNode: term ? `${term.tagName}.${term.className}` : null, text: document.body.innerText.slice(0, 1500) };
})()
