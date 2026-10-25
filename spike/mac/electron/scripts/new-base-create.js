(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const click = async (re) => {
		const b = [...document.querySelectorAll("button")].find((e) => re.test(e.textContent.trim()));
		if (!b) throw new Error(`no button ${re}`);
		b.click();
		await sleep(1200);
	};
	await click(/^\+ New base$/);
	await click(/^projects\/$/);
	await click(/^demo\/$/);
	const name = document.querySelector('input[placeholder="Base name"]');
	name.value = "demo-base";
	name.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(300);
	await click(/^Open the base here$/);
	await sleep(8000); // the member pi starts and joins the net
	const member = document.body.innerText.slice(0, 800);
	setTimeout(() => (location.href = document.baseURI), 100); // back to the net overview, after this script has returned
	return { memberPage: member };
})()
