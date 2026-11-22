# Container image for aula-mcp (deployed by charts/aula-mcp), built from the
# repository root so it ships exactly the checked-out code:
#
#   podman build -t <registry>/aula-mcp:<tag> .
#
# Same base as homeassistant-addon/Dockerfile and for the same reasons: pnpm
# install needs Node (node:sqlite), the server needs Bun (Bun.serve), and
# Corepack only ships with Node < 25.
FROM node:24-bookworm-slim

COPY --from=oven/bun:1.3-debian /usr/local/bin/bun /usr/local/bin/bun

RUN corepack enable \
  && corepack prepare pnpm@11.1.3 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod

COPY scripts/aula-parent-login.sh /usr/local/bin/aula-parent-login
RUN chmod 755 /usr/local/bin/aula-parent-login \
  && mkdir -p /data && chown node:node /data

USER node
ENV AULA_MCP_DIR=/data \
  AULA_MCP_HOST=0.0.0.0 \
  AULA_MCP_NO_KEYCHAIN=1 \
  HOME=/data
EXPOSE 7878

CMD ["bun", "packages/mcp-server/src/server.ts"]
