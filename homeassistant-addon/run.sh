#!/bin/sh
# Home Assistant add-on entry. Translates HA-style options (read from
# /data/options.json, populated by Supervisor) into the env vars aula-mcp's
# server entry expects, then exec's into the long-running MCP server.
set -eu

OPTIONS_FILE=/data/options.json

if [ -f "$OPTIONS_FILE" ]; then
  AULA_MCP_KEY="$(jq -r '.aula_mcp_key // empty' "$OPTIONS_FILE")"
  LOG="$(jq -r '.log // false' "$OPTIONS_FILE")"
  ALLOW_REMOTE="$(jq -r '.allow_remote // true' "$OPTIONS_FILE")"
else
  # Running outside Supervisor (e.g. local docker test). Fall back to env.
  AULA_MCP_KEY="${AULA_MCP_KEY:-}"
  LOG="${LOG:-false}"
  ALLOW_REMOTE="${ALLOW_REMOTE:-true}"
fi

# `/config/aula-mcp/` is mapped from Supervisor's /config volume. The user
# copies their `tokens.json` + `.key` here after running `aula tokens export`
# on a workstation — see homeassistant-addon/README.md.
export AULA_MCP_DIR="/config/aula-mcp"
mkdir -p "$AULA_MCP_DIR"

# The MCP server refuses non-loopback binds by default; HA's whole point is
# serving the LAN, so the default `allow_remote: true` opens it up. Setting
# `allow_remote: false` keeps the MCP traffic loopback-only inside the
# container — useful if you front it with HA Ingress / a reverse proxy, but
# in that case the LAN can't reach :7878 directly so HA's MCP client
# integration won't either. Don't flip unless you know what you're doing.
if [ "$ALLOW_REMOTE" = "true" ]; then
  export AULA_MCP_HOST="0.0.0.0"
  export AULA_MCP_ALLOW_REMOTE=1
else
  export AULA_MCP_HOST="127.0.0.1"
fi

# Boot the in-addon setup/login UI on the port HA Ingress proxies to.
# config.yaml's `ingress_port` MUST stay in sync with this value.
export AULA_MCP_INGRESS_PORT=8099

if [ "$LOG" = "true" ]; then
  export AULA_MCP_LOG=1
fi

if [ -n "$AULA_MCP_KEY" ]; then
  export AULA_MCP_KEY
fi

cd /app
exec bun packages/mcp-server/src/server.ts
