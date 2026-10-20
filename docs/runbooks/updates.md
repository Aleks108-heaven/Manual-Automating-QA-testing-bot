# Runbook: dependency and browser updates

Updates are the moment a poisoned package or a vulnerable browser gets in, so they follow a fixed routine. Do it monthly, and straight away for a published browser or Playwright security fix.

Owner: the bot maintainer. Backup: the security reviewer. Last reviewed: 20 Oct 2026.

## Routine

1. **Start from a clean tree.** `git status` shows nothing uncommitted, and `npm run check` passes.
2. **Look at what is outdated.** `npm run outdated`. Update one thing at a time. For each candidate, choose a version that has been published for at least 14 days, and read its changelog.
3. **Update.** `npm install --save-exact <package>@<version>`. Never use `@latest`, `^` or `~`. The `.npmrc` already refuses install scripts and saves exact versions.
4. **Review the lockfile diff.** `git diff package-lock.json`. Every new package must come from registry.npmjs.org and appear in the diff for a reason. Anything unexpected stops the update.
5. **Check the supply chain.** `npm run check:supply-chain` (known vulnerabilities and registry signatures). `npm run check:pins` runs inside `npm run check` and verifies the lockfile's hosts and hashes.
6. **If Playwright changed:** run `npx playwright install chromium` to fetch the matching browser, and update the Dockerfile in the same commit. Change the image tag to `v<new version>-noble` and replace the digest. Get the digest with:
   `Invoke-WebRequest -Method Head -Uri https://mcr.microsoft.com/v2/playwright/manifests/v<version>-noble -Headers @{Accept="application/vnd.oci.image.index.v1+json"}` and read the `Docker-Content-Digest` header.
7. **Run everything.** `npm run check`. Once the golden set exists (M5), run it too, and compare the match rate with the last run. A changed P1 verdict blocks the update.
8. **Record it.** Add a line to the manual's change log if bot behavior changed. Commit with the old and new versions in the message.

## What to watch for

- A new maintainer or a sudden release on a package that rarely changes.
- A package that gained an install script or a new network dependency.
- A version published in the last few days, even if it looks harmless.
- A lockfile diff far larger than the package change explains.

## Roll back

`git revert` the update commit, run `npm ci`, and run `npm run check`.

## Machine hygiene

This repository is private and is not published to npm, so no publish token should exist on the machine that builds it. Keep secrets out of the repository and out of `.env` files on shared machines. Use two-factor authentication on the code host, and review any new access token before creating it.
