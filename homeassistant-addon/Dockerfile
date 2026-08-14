# Home Assistant add-on image for aula-mcp.
#
# This add-on uses the official Node.js 22 image as its build base rather than
# Home Assistant's base images.
#
# Node.js is used for dependency installation because the project relies on
# packages that import Node's built-in `node:sqlite` module during installation.
# Bun currently does not provide that built-in module, so using a Bun base image
# causes `pnpm install --frozen-lockfile` to fail.
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
# release tag or commit-compatible branch name through Home Assistant's
# add-on build configuration.
FROM node:22-bookworm-slim

ARG AULA_MCP_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Bun is required at runtime — the mcp-server package uses Bun.serve directly
# and won't run under plain Node.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@10 --activate

WORKDIR /app

RUN git clone --depth 1 --branch "${AULA_MCP_REF}" \
  https://github.com/Casperjuel/aula-mcp.git .

RUN pnpm install --frozen-lockfile

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 7878

CMD ["/run.sh"]
