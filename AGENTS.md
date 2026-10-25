# straw-boss-desk

An Electron desktop app (macOS and Windows) that builds a pi coding stack on a bare machine and opens the pi-straw-boss GUI as its main window. The design record is `docs/specs/2026-10-25-design.md`; read it before changing behavior.

## Rules

- Write code, comments, and agent instructions in English. User-facing strings go through i18n; Traditional Chinese is the first locale.
- Everything the app installs goes under its own app data `tools/` folder. Never write to the user's global Node, Git, pi, or herdr setup, and never require admin rights.
- pi packages come from npm at the versions in `stack.json`. Do not vendor or submodule them; a missing seam is fixed in the upstream package and released.
- Every external download is pinned by version and verified by SHA256.
- Keep both platforms working: platform-specific code lives behind one interface per concern, and CI runs on macOS and Windows.
- Secrets go through the OS keychain (Electron safeStorage); never into logs, `stack.json`, or files in the repo.

## Development on the author's machine

The author runs a live herdr server and pi sessions on this Mac. Anything this repo starts for development or tests must use its own herdr socket, its own `PI_CODING_AGENT_DIR`, and its own app data folder, and must stop only the processes it started (record their PIDs).

## Commits

Conventional Commits, no AI tool attribution, stage files by name.
