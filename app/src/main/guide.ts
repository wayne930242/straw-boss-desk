// The PM guide (`docs/pm-guide.zh-TW.md` in the repository, which is public). The app opens one page of it: how to remove, by hand, a sign-in that **Remove all data** left in the credential store
// (spec: Open for the boss, item 13). The address is a constant of the build, built from the section's heading; a test keeps it equal to the heading in the file.

export const GUIDE_REPO = "https://github.com/wayne930242/straw-boss-desk/blob/main/docs/pm-guide.zh-TW.md";
export const GUIDE_REMOVE_HEADING = "手動移除留下的登入";

/** GitHub's anchor for a heading: lower case, spaces to hyphens, punctuation dropped; a CJK heading keeps its characters. */
export const anchorOf = (heading: string): string => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");

export const guideUrl = (): string => `${GUIDE_REPO}#${encodeURIComponent(anchorOf(GUIDE_REMOVE_HEADING))}`;
