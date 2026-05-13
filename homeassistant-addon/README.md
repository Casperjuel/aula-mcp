# aula-mcp — Home Assistant add-on

Runs the `aula-mcp` server (the MCP interface for the Danish school platform
Aula) inside your Home Assistant supervisor, exposing the standard endpoints
at `http://homeassistant.local:7878/`. HA's official
[`mcp` (client) integration](https://www.home-assistant.io/integrations/mcp/)
points at `/sse`, and Assist + your chosen LLM (Anthropic, OpenAI, Ollama,
etc.) gets every `aula.*` tool — including for voice queries like
*"hvad er lektien i dag?"*.

## Install

[![Open your Home Assistant instance and add the aula-mcp add-on repository.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/Casperjuel/aula-mcp)

1. **Click the badge above** (or manually: Settings → Add-ons → Add-on Store
   → ⋮ (top-right) → Repositories → paste `https://github.com/Casperjuel/aula-mcp`).
2. **Install the `aula-mcp` add-on** from the now-visible repository.
3. **Don't start it yet** — first transfer your Aula tokens (next section).

## First-time: log in via the add-on's web UI

1. Start the add-on.
2. Open the **aula-mcp** entry in your HA sidebar (added automatically via the
   add-on's Ingress panel). You should see *"Ikke logget ind"*.
3. Type your **MitID username** and click **Start login**.
4. Two QR codes appear. Open your **MitID app**, scan either of them (they
   alternate as an anti-phishing check), and approve the login on your phone.
5. If MitID returns multiple identities (rare — typically only parents with
   several login routes), pick the one your school knows you by.
6. On success the page flips to *"Logget ind"* and the tokens are persisted
   encrypted in `/config/aula-mcp/` automatically.

The whole flow happens inside HA's Ingress proxy — your browser never leaves
the HA UI, and the MitID-app talks to nemlog-in.dk directly. The add-on only
sees the resulting OAuth tokens.

### Fallback: workstation export

If you'd rather not type your MitID username into HA's UI (or you're hardening
a setup with no browser access), the original workstation flow still works:

```sh
git clone https://github.com/Casperjuel/aula-mcp.git && cd aula-mcp
pnpm install
pnpm login                                 # MitID QR-code flow on workstation
pnpm aula tokens export ./aula-bundle      # writes tokens.json + .key
scp aula-bundle/tokens.json aula-bundle/.key homeassistant:/config/aula-mcp/
```

The encrypted bundle is interchangeable — the add-on picks it up on next
restart regardless of which path produced it.

## Configure

In the add-on's Configuration tab:

| Option | Default | Notes |
| --- | --- | --- |
| `aula_mcp_key` | `""` | Encryption key for the token store. Leave empty unless you set one when exporting tokens. |
| `log` | `false` | Verbose logs (auth flow, HTTP calls). Useful when something's stuck. |
| `allow_remote` | `true` | Bind to `0.0.0.0` so HA + other LAN devices can reach the server. Disable only if you front the addon with Ingress / reverse proxy. |

Start the add-on. Check the log — should see `aula-mcp listening on http://0.0.0.0:7878/mcp`.

## Connect HA's MCP client

1. Settings → Devices & Services → Add Integration → **Model Context Protocol**.
2. **SSE Server URL:** `http://homeassistant.local:7878/sse` (or `http://<container-host>:7878/sse` if HA isn't on `homeassistant.local`).
3. Save. HA discovers the tool surface (`aula.discover`, `aula.ugeplan.*`,
   `aula.lektier.easyiq`, `aula.messages.*`, …) and exposes it to whatever
   conversation agent you've configured (Settings → Voice assistants).

## Verify

Open Settings → Voice assistants → your Assist pipeline → ask:

> *Hvad står der på ugeplanen for [barn] næste uge?*

The LLM should call `aula.discover` once, then a ugeplan-tool. If you see
"tool not found" or auth errors, check the add-on log.

## Update

The add-on tracks `main` for now (no per-version published images). Re-install
the add-on to rebuild against the latest commit.

## Limitations

- **No OAuth on the MCP endpoint yet.** The server is single-user — anyone
  with LAN access to `:7878` can drive your Aula tokens. Inside a household
  on a trusted LAN this is generally fine; if your network has untrusted
  peers, set `allow_remote: false` and front the add-on with HA Ingress.
- **MitID re-login still happens on a workstation.** When your Aula refresh
  token expires (Aula rotates aggressively), re-run `pnpm login` + `pnpm aula
  tokens export` and recopy the bundle. There's no headless re-login flow.
- **One arch image per build.** Pre-built multi-arch images aren't published;
  Supervisor builds the image locally on install. First start can take a
  minute or two on a Raspberry Pi.
