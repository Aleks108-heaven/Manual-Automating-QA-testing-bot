# Runner image. Written on 20 Oct 2026; built and run for the first time on 6 Nov 2026 (it needed `COPY evals`).
# It runs a case with the browser sandbox OFF (the default seccomp profile blocks the sandbox); see
# docs/runbooks/container-runner.md for the status and for keeping the sandbox on with a seccomp profile.
# What it is for: an ephemeral, non-root runner with no network (see docs/runbooks/container-runner.md).
#
# The base image is the official Playwright image for the pinned Playwright version, pinned by digest.
# Update the tag and the digest together when Playwright is updated (docs/runbooks/updates.md).
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# Fail the build early if the image's Node is too old to run the TypeScript files directly.
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<24||(a===24&&b<2)) { console.error('Node 24.2 or newer is required, found '+process.version); process.exit(1) }"

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, from the lockfile only. Install scripts stay disabled through .npmrc.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY config ./config
COPY prompts ./prompts
COPY cases ./cases
COPY fixtures ./fixtures
# src/cli.ts imports the eval suites at load time, so they have to be in the image even for a plain run.
COPY evals ./evals
COPY src ./src
COPY tests/ci/scripts ./tests/ci/scripts

# Run as the image's non-root user. Never run the browser as root.
USER pwuser
ENTRYPOINT ["node", "src/cli.ts", "run"]
CMD ["cases/TC-FORM-001.yaml"]
