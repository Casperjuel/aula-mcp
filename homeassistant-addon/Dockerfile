# Home Assistant add-on image for aula-mcp.
#
# We use the official Bun image as a base rather than HA's base image — the
# server is plain TypeScript-on-Bun and doesn't need s6-overlay/bashio. HA
# runs whatever image config.yaml points at; the protocol is just "long-
# running process with a Dockerfile and config.yaml beside it."
#
# HA Supervisor uses *this directory* as the Docker build context, so we
# can't reach up into the monorepo with `COPY ../packages`. Instead we git-
# clone the source inside the build. The AULA_MCP_REF arg lets you pin to a
# tag; default is `main` so a re-install always picks up the latest.
ARG BUILD_FROM=oven/bun:1.3-debian
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

ARG AULA_MCP_REF=main

# jq parses the user's add-on options (HA writes them to /data/options.json
# at startup). git clones the source. ca-certificates so HTTPS to Aula /
# MitID works at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm is the workspace tool of record for this monorepo. Bun's installer
# can't honour pnpm-lock.yaml, so install pnpm via Bun's npm-compat layer
# and let it resolve the workspace deterministically.
RUN bun install -g pnpm@10

WORKDIR /app

RUN git clone --depth 1 --branch "${AULA_MCP_REF}" \
  https://github.com/Casperjuel/aula-mcp.git .

RUN pnpm install --frozen-lockfile

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 7878

CMD ["/run.sh"]
