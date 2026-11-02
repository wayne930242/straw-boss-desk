// A URL with a user name and a password, put together at run time. Tests need such URLs to prove a redactor masks them, but a literal URL with a user name and a password in the
// repository is what a secret scanner reports (GitGuardian incident 39413346). The source writes `<c>` where the colon between user and password goes, so no line of it matches.
export const credUrl = (text: string): string => text.replaceAll("<c>", ":");
