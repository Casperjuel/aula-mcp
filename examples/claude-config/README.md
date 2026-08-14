# Wiring aula-mcp into Claude Code / Claude Desktop

The MCP server ships two transports. **Streamable HTTP** listens on `http://127.0.0.1:7878/mcp` by default and suits setups where the server runs somewhere other than the client (Home Assistant, a Pi, a VPS). **stdio** lets the client spawn the process itself, with no port and no daemon, which is the simpler choice when client and server share a machine. Both expose the same tools.

## Claude Code (CLI)

`~/.config/claude-code/config.json` (Linux) or `~/Library/Application Support/Claude Code/config.json` (macOS):

See [`claude-code.json`](./claude-code.json) for a copy-pasteable snippet.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent Windows path. Restart the app after editing.

See [`claude-desktop.json`](./claude-desktop.json).

## stdio

Point the client at `packages/mcp-server/src/server-stdio.ts` and it starts the server on demand:

```sh
claude mcp add aula -- bun /absolute/path/to/aula-mcp/packages/mcp-server/src/server-stdio.ts
```

For Claude Desktop, see [`claude-desktop-stdio.json`](./claude-desktop-stdio.json) and correct the path to your own checkout.

That example uses a bare `bun` as the command, which relies on `bun` being on the spawned process's `PATH`. Claude Code inherits your shell's, so it just works. Claude Desktop on macOS does not — a GUI-launched app gets a minimal `PATH` that usually excludes `~/.bun/bin`, and the server fails to start with no obvious reason. Run `which bun` and use the absolute path there instead:

```json
"command": "/Users/you/.bun/bin/bun"
```

`pnpm mcp:stdio` works too when run from the repo root. stdout carries JSON-RPC, so nothing else may write to it. pnpm's own `$ <command>` banner goes to stderr and is therefore harmless. Set `AULA_MCP_LOG=1` for server logs (also stderr). The HTTP-only variables (`AULA_MCP_PORT`, `AULA_MCP_HOST`, `AULA_MCP_ALLOW_REMOTE`) are ignored on this transport.

## Prerequisites

1. Run `pnpm --filter @aula-mcp/cli dev login` once to authenticate.
2. Start the server: `pnpm --filter @aula-mcp/mcp-server dev`. On stdio you can skip this entirely, since the client spawns it.
3. Restart your MCP client.

## What the agent should do first

Tell the agent (in its system prompt or first message): **"Call `aula.discover` first, then use the listed subordinate tools to answer the user's question."** That way it picks integrations dynamically based on which providers your school uses.
