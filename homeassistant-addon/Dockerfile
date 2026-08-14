# Home Assistant add-on image for aula-mcp.
#
# This add-on uses the official Node.js 24 image as its build base rather than
# Home Assistant's base images.
#
# Node.js is used for dependency installation because the project relies on
# packages that import Node's built-in `node:sqlite` module during installation.
# Bun currently does not provide that built-in module, so using a Bun base image
# causes `pnpm install --frozen-lockfile` to fail.
#
# Why 24 specifically, and not 22 or latest: 24 is the active LTS line (22 went
# maintenance-only in Oct 2025 and is EOL 2027-04-30), and pnpm 11 requires
# node >=22.13 so 24 clears that comfortably. The upper bound matters too —
# Corepack ships with Node "from 14.19.0 up to (but not including) 25.0.0", so
# `corepack enable` below breaks on Node 25+. Bumping this base past 24 means
# installing Corepack separately or switching to a plain `npm i -g pnpm`.
#
# The aula-mcp server itself still requires Bun at runtime because the MCP server
# uses Bun-specific APIs such as `Bun.serve`. Bun is therefore installed
# separately after the Node.js base image has been initialized.
#
# The add-on does not require Home Assistant's s6-overlay/bashio environment.
# Home Assistant Supervisor simply builds this Dockerfile and starts the process
# defined by the CMD below.
#
# Home Assistant Supervisor uses the `homeassistant-addon` directory as the
# Docker build context. That means files elsewhere in the monorepo cannot be
# referenced directly with commands such as:
#
#   COPY ../packages /app/packages
#
# Instead, the complete aula-mcp repository is cloned during the image build.
#
# AULA_MCP_REF controls which branch or tag is cloned. It defaults to `main`,
# allowing a normal reinstall to build from the latest upstream version.
#
# For reproducible releases, AULA_MCP_REF can instead be set to a specific
# release tag or commit-compatible branch name through build.yaml beside this
# file.
FROM node:24-bookworm-slim

ARG AULA_MCP_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bun is required at runtime — the mcp-server package uses Bun.serve directly
# and won't run under plain Node. Copy the binary out of the official image
# rather than piping bun.sh/install into a shell: that script is unpinned, so
# every rebuild would pull whatever Bun is current and could break the runtime
# on a user's reinstall. oven/bun publishes amd64 and aarch64, matching the
# arches this add-on supports.
COPY --from=oven/bun:1.3-debian /usr/local/bin/bun /usr/local/bin/bun

# pnpm resolves the workspace; the version of record is package.json's
# `packageManager` field. Pre-activating that exact version warms the Corepack
# cache here instead of mid-`pnpm install`, and fails the build loudly if the
# pin ever drifts from what the repo expects.
RUN corepack enable \
  && corepack prepare pnpm@11.1.3 --activate

WORKDIR /app

RUN git clone --depth 1 --branch "${AULA_MCP_REF}" \
  https://github.com/Casperjuel/aula-mcp.git .

RUN pnpm install --frozen-lockfile

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 7878

CMD ["/run.sh"]
