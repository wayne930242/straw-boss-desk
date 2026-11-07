// Test code only; never shipped. Whether the Team recipe card's text is one of its two "busy" sentences (`settings.recipe.errorBusy`, `errorBusyProject`), which is what the card shows for an
// error of kind `busy` and for no other kind (`renderer/settings/recipe.ts`). The card has no attribute for the kind, so the retry of the raw-URL check reads the sentence (task 15, T15R-F002).
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export function busySentenceShown(cardText: string, recipe: { errorBusy: string; errorBusyProject: string }): boolean {
	const text = flat(cardText);
	if (text.includes(flat(recipe.errorBusy))) return true;
	const [head = "", tail = ""] = recipe.errorBusyProject.split("{repository}");
	return head.trim() !== "" && text.includes(flat(head)) && text.includes(flat(tail));
}
