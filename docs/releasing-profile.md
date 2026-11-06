# Releasing the team profile

`straw-boss-desk-profile` (folder `profile/`) is published to npm by `.github/workflows/profile-release.yml` when a `profile-v*` tag is pushed. The workflow uses npm Trusted Publishing (OIDC); there is no npm token and no approval gate.

## One-time setup (boss, on npmjs.com)

1. Sign in at https://www.npmjs.com and open https://www.npmjs.com/package/straw-boss-desk-profile.
2. Click **Settings**.
3. Find **Trusted Publisher** and click **GitHub Actions**.
4. Fill in: Organization or user `wayne930242`, Repository `straw-boss-desk`, Workflow filename `profile-release.yml`, Environment name blank.
5. Click **Set up connection**.

## Per release

1. Bump `version` in `profile/package.json` (and `profile/package-lock.json`), merge to main through the usual change.
2. From the merged main commit: `git tag profile-v<version>` then `git push origin profile-v<version>`.
3. Watch the `profile-release` run. It fails if the tag differs from `profile-v` + the package version, if the version already exists on npm, or if the profile tests fail. After publishing it prints the version's integrity from `npm view`. The wait step reads the registry with `--prefer-online`, because an earlier step caches the package page for five minutes.
4. In a separate change, bump the profile pin and generation in `stack.json` to the new version.
