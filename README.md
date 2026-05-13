# aula-mcp

[![CI](https://github.com/Casperjuel/aula-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Casperjuel/aula-mcp/actions)
[![Licens: MIT](https://img.shields.io/badge/Licens-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Bun-≥%201.3-black?logo=bun)](https://bun.sh)
[![pnpm](https://img.shields.io/badge/pnpm-≥%2010-F69220?logo=pnpm)](https://pnpm.io)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-Streamable_HTTP-6B5BFF)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-209%20pass-brightgreen)](#udvikling)

**Hvad det her er — og hvad det *ikke* er:**

`aula-mcp` er en server der sidder mellem en MCP-klient (LLM) og Aula — et interface, ikke meget mere. **LLM'en er ikke en del af projektet.** Du vælger selv klient (Claude Code, Claude Desktop, ChatGPT, Cursor, Ollama, LM Studio osv.), og den kører hvor den nu kører — i Anthropic/OpenAI's cloud, eller lokalt hvis du bruger Ollama el.lign.

**Projektet er altså ikke en garanti for at børnenes data kun bliver lokalt.** Om dataen forbliver lokal afhænger 100 % af hvilken klient du tilkobler — det er dit eget ansvar, ikke noget `aula-mcp` selv kan love.

> ⚠️ **Brug det med omtanke**
>
> Hobby-eksperiment, ingen garantier. Det rør ved MitID og dine børns skoledata — kig koden igennem (eller få en udvikler-bekendt til det) før du kobler en LLM på. Eget ansvar.

> ⚠️ **Det er klienten der får dataen at se — ikke serveren**
>
> Serveren her kører lokalt og sender intet videre på egen hånd. **Men den MCP-klient du tilkobler — Claude, ChatGPT, en anden cloud-LLM — får alt det den læser sendt videre til provideren (Anthropic, OpenAI osv.) for at kunne svare dig.** Det er ikke "alt sammen lokalt" bare fordi serveren er det. Sådan fungerer MCP: klienten ræsonnerer, serveren henter data.
>
> | | Hvor det går hen |
> | --- | --- |
> | MitID-credentials og OAuth-tokens | Forbliver lokalt — macOS Keychain eller AES-256-GCM-krypteret fil. Bruges kun til at hente data fra Aula. |
> | Selve dataen (beskeder, ugeplaner, børnenavne osv.) | Sendes til den MCP-klient du vælger. Cloud-LLM → providerens servers (typisk USA). Lokal LLM → forbliver lokalt. |
>
> **Vil du have det 100 % lokalt?** Brug en lokal LLM som klient: [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [llama.cpp](https://github.com/ggml-org/llama.cpp), Mistral via Hugging Face, etc. Alle taler MCP og kører på din egen hardware.

TypeScript + Bun + Hono. Bygget på skuldrene af [`scaarup/aula`](https://github.com/scaarup/aula) (Python/Home Assistant). Stadig i bevægelse — tools kan ændre signatur, kommandoer kan blive omdøbt, og enkelte vendor-integrationer er kun testet mod ét sæt skoler.

![Claude Code spørger om næste uges ugeplan](./docs/demos/claude-code.gif)

---

## Indhold

- [Hvad serveren rør ved](#hvad-serveren-rør-ved)
- [Kom i gang](#kom-i-gang)
- [Forbind til Claude Code (eller claude.ai)](#forbind-til-claude-code-eller-claudeai)
- [Self-hosting](#self-hosting)
- [Hvad er der i manifestet](#hvad-er-der-i-manifestet)
- [CLI-kommandoer](#cli-kommandoer)
- [Konfiguration](#konfiguration)
- [Arkitektur](#arkitektur)
- [Rettelser fra Aula-issues](#rettelser-fra-aula-issues)
- [Fejlfinding](#fejlfinding)
- [Udvikling](#udvikling)
- [Bidrag](#bidrag)
- [Privatliv & jura](#privatliv--jura)

---

## Hvad serveren rør ved

Hvad selve `aula-mcp`-serveren gør (og ikke gør). Hvor dataen ender bagefter er klientens domæne — se disclaimeren øverst.

- **MitID-credentials og OAuth-tokens bliver lokalt.** macOS: Keychain (`security` CLI). Linux/Windows: AES-256-GCM-krypteret fil i `~/.config/aula-mcp/`. De forlader ikke din computer.
- **Serveren binder kun til `127.0.0.1`.** Den nægter at binde til en ikke-loopback adresse medmindre du sætter `AULA_MCP_ALLOW_REMOTE=1`. Default: kun programmer på din egen computer kan ramme den.
- **Ingen telemetri, ingen tredjepart.** Programmet taler kun med Aula's egne servere (`api.aula.dk`, `login.aula.dk`), MitID (`nemlog-in.mitid.dk`) og vendor-API'erne (EasyIQ, Meebook m.fl. — hvis din skole har dem).
- **MitID-godkendelsen går igennem MitID's egen infrastruktur.** Protokollen er skrevet om i TypeScript, men selve godkendelsen (QR-koden i MitID-appen) sker som altid mellem din enhed og nemlog-in.dk.
- **`--debug`-tracen er opt-in og automatisk redaktet.** Cookies, OAuth-koder, MitID-payloads, M1-værdier, flowValueProof, adgangstokens osv. fjernes *før* noget skrives til disk. Trygt at vedhæfte en GitHub-issue.
- **Loopback-only = familien kan ikke ramme serveren fra deres egen enhed.** Skal flere enheder i husstanden kunne spørge, så enten reverse proxy (se Self-hosting) eller en Home Assistant-integration på et tidspunkt.

---

## Kom i gang

Kræver **[Bun](https://bun.sh) ≥ 1.3** og **[pnpm](https://pnpm.io) ≥ 10**. macOS eller Linux.

```sh
git clone git@github.com:Casperjuel/aula-mcp.git
cd aula-mcp
pnpm install

# 1. Sanity-tjek
pnpm typecheck && pnpm lint && pnpm test

# 2. Første-gangs MitID-login (QR-kode i MitID-appen)
pnpm login

# 3. Health-check af alle Aula-endpoints
pnpm doctor

# 4. Start MCP-serveren (http://127.0.0.1:7878/mcp)
pnpm mcp
```

De fleste CLI-kommandoer har en kort genvej: `pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`. Til alt andet videresender `pnpm aula <kommando>` til CLI'en (fx `pnpm aula transcript list`, `pnpm aula log --last 5`).

`doctor`-kommandoen kører hvert read-endpoint igennem og rapporterer status + svartid for hvert. Det er det hurtigste "virker det her overhovedet?"-tjek:

![aula doctor kører igennem alle endpoints](./docs/demos/doctor.gif)

`whoami` viser hvilken identitet dine tokens hører til, og hvilke børn der returneres af `getProfilesByLogin`:

![aula whoami viser identitet + børn](./docs/demos/whoami.gif)

---

## Forbind til Claude Code (eller claude.ai)

### Claude Code

```sh
# 1. Server kører i ét terminalvindue
pnpm mcp

# 2. Registrér serveren med Claude Code (kun én gang)
claude mcp add --transport http aula http://127.0.0.1:7878/mcp

# 3. I en hvilken som helst Claude Code-session, bekræft at den er forbundet
/mcp
```

Så kan du bare spørge naturligt — børnenes navne bliver fuzzy-matched mod `discover`-manifestet, du behøver ikke kende deres ID:

> *hvad står der på ugeplanen næste uge for theo*

Claude kalder `aula.discover` én gang, vælger den rigtige ugeplan-vendor for din skole ud fra `detectedWidgets`, og svarer på dansk med dansk-formatterede datoer.

### Claude Desktop

Drop snippet'et fra [`examples/claude-config/claude-desktop.json`](./examples/claude-config/claude-desktop.json) ind i `~/Library/Application Support/Claude/claude_desktop_config.json`.

### claude.ai (web)

Web-UI'et kræver en offentlig HTTPS-URL — `127.0.0.1` virker ikke, fordi forbindelsen sker server-side fra Anthropic's cloud. Til en hurtig test:

```sh
cloudflared tunnel --url http://127.0.0.1:7878
# → https://<random>.trycloudflare.com — indsæt med `/mcp` på enden
```

> ⚠️ **Tunnel-URL'en er offentligt tilgængelig så længe den kører** — hvis nogen gætter den, kan de styre dine Aula-tokens. Fint til en hurtig demo, men lad den ikke stå åben. Til en permanent setup, se næste sektion.

---

## Self-hosting

Hvis du vil have serveren kørende uden at have din laptop åben, er der et par måder. Alle holder *serveren* lokalt — hvor klienten kører er stadig et separat valg (se top-disclaimeren).

### Mulighed 1: Single binary på en Linux-boks (Pi, NAS, gammel laptop, billig VPS)

Den simpleste vej. Compile-til-én-binary og kør den under systemd.

```sh
# Byg en standalone binary (~50 MB)
bun build --compile --outfile dist/aula-mcp packages/mcp-server/src/server.ts

# Kopiér til din server (Pi, NAS, VPS)
scp dist/aula-mcp aula:/usr/local/bin/aula-mcp
```

**Tokens på serveren** — to veje, vælg den der passer dig:

A. *Log ind direkte på serveren via SSH.* QR-koderne renderes i SSH-sessionen, scan med MitID-appen på telefonen. Kører på enhver maskine du kan ssh'e ind på med en normal TTY.

```sh
ssh aula
aula login
```

B. *Eksportér tokens fra din Mac (eller fra hvor du allerede er logget ind).* macOS Keychain kan ikke flyttes mellem maskiner, så `aula tokens export` re-krypterer dem til en bærbar fil-bundle.

```sh
# På din Mac
aula tokens export ~/aula-bundle

# Flyt til serveren — bundle indeholder live credentials, behandl som
# adgangskoder. SSH krypterer i transit.
scp ~/aula-bundle/tokens.json ~/aula-bundle/.key \
    aula:/var/lib/aula-mcp/

# Slet bundle på din Mac når du er færdig
rm -rf ~/aula-bundle
```

Eller på serveren: `aula tokens import ~/aula-bundle` hvis du vil have CLI'en til at lægge filerne det rigtige sted.

Eksempel `systemd`-unit i `/etc/systemd/system/aula-mcp.service`:

```ini
[Unit]
Description=aula-mcp server
After=network.target

[Service]
Type=simple
User=aula
ExecStart=/usr/local/bin/aula-mcp
Environment=AULA_MCP_PORT=7878
Environment=AULA_MCP_HOST=127.0.0.1
Environment=AULA_MCP_DIR=/var/lib/aula-mcp
Environment=AULA_MCP_KEY=<en lang hex-streng eller passphrase>
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Aktivér med `systemctl enable --now aula-mcp`. Tjek `journalctl -u aula-mcp -f` for logs.

### Mulighed 2: Bag en authenticeret reverse proxy (familien tilgår fra mobilen)

Default binder serveren kun til `127.0.0.1`. For at familien (eller dig selv på telefonen via VPN) skal kunne ramme den, sæt en reverse proxy foran med authentication. Eksempel med [Caddy](https://caddyserver.com):

```caddyfile
aula.dithjem.dk {
    basicauth {
        familie $2a$14$<bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:7878
}
```

`AULA_MCP_HOST` forbliver `127.0.0.1` — Caddy står for TLS, basic auth, rate limit. Det er Caddy der er på det offentlige internet, ikke selve MCP-serveren.

> ⚠️ Hvis du *skal* exposé serveren direkte (springe proxy-laget over) skal du eksplicit sætte `AULA_MCP_ALLOW_REMOTE=1` — det er en kontrolleret, tilsigtet handling, ikke et uheld.

### Mulighed 3: Home Assistant add-on

Den nemmeste vej for HA-brugere. `aula-mcp` kører som en del af din HA-installation og er tilgængelig fra HA's Voice/Assist + alle dine HA-automatiseringer. Hvis du har **Nabu Casa**, åbner det også for sikker fjernadgang via deres tunnel.

[![Open your Home Assistant instance and add the aula-mcp add-on repository.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/Casperjuel/aula-mcp)

1. Klik badget ovenfor (eller manuelt: Settings → Add-ons → ⋮ → Repositories → indsæt `https://github.com/Casperjuel/aula-mcp`).
2. Installer `aula-mcp` add-on'en fra det repository der dukker op.
3. Kopier dine tokens fra en workstation ind i `/config/aula-mcp/` (kør `pnpm login` + `pnpm aula tokens export` på workstation, og SCP/Samba til HA).
4. Settings → Devices & Services → Add Integration → **Model Context Protocol** → `http://homeassistant.local:7878/sse`.

Full walkthrough med detaljerede skridt: [`homeassistant-addon/README.md`](./homeassistant-addon/README.md).

`aula-mcp` taler både den nye Streamable HTTP-protokol (`/mcp`) og den ældre SSE-dialekt (`/sse`) — HA's officielle [`mcp` (client) integration](https://www.home-assistant.io/integrations/mcp/) bruger SSE, så du peger den bare på `http://<ha-host>:7878/sse`. Så har Assist + dit valgte LLM (Anthropic / OpenAI / Ollama) adgang til alle `aula.*` tools — inklusive via voice.

### Mulighed 4: VPS i Tyskland (Hetzner, Coolify)

Hvis du allerede har en europæisk VPS (Hetzner, Scaleway, OVH) og en domæne — så er det bare en `git clone` + `bun install` + systemd-unit som mulighed 1.

### Backup & nøgle-håndtering

- **Token-store**: gem en kryptert kopi af `~/.config/aula-mcp/tokens.json` + `.key` (eller Keychain-eksport på macOS). Mister du dem, skal du logge ind igen — ingen panik, men irriterende.
- **AULA_MCP_KEY**: hvis du bruger fil-backenden i produktion, sæt en stærk `AULA_MCP_KEY` (env-var) og lad være med at committe den. Roterer du den, skal du re-loginne.
- **Nye Aula-versioner**: Aula bumper deres API-version 1-2 gange om året. `aula-mcp` prober selv den nye version ved næste kald (intet manuelt arbejde), men hold et øje på release-noter for breaking changes der dukker op.

---

## Hvad er der i manifestet

Agenter kalder `aula.discover` én gang og genbruger resultatet resten af sessionen. Manifestet fortæller agenten hvem brugeren er, hvilke børn man kan handle på vegne af, hvilke tredjeparts-widgets skolerne har konfigureret, og hvilke MCP-tools der skal kaldes:

![aula.discover-manifest pretty-printet](./docs/demos/discover.gif)

Form:

```ts
{
  user: { name, username, identityName? },
  children: [{ id, name, userId?, institution: { id, name?, code? } }],
  apiVersion: 23,
  tokens: { expires_at, seconds_remaining },
  detectedWidgets: ['0001', '0029', '0030'],   // fra Aula's pageConfiguration
  capabilities: {
    profiles:      { summary, tools: ['aula.profiles.list'] },
    presence:      { summary, tools: ['aula.presence.today'] },
    calendar:      { summary, tools: ['aula.calendar.events'] },
    messages:      { summary, tools: ['aula.messages.list_threads', 'aula.messages.get_thread'] },
    notifications: { summary, tools: ['aula.notifications.list'] },
    posts:         { summary, tools: ['aula.posts.list'] },
    ugeplan:       { summary, tools: ['aula.ugeplan.easyiq'] },          // kun den detekterede vendor
    opgaver:       { summary, tools: ['aula.opgaver.minuddannelse'] },
    ugebrev:       { summary, tools: ['aula.ugebrev.minuddannelse'] },
    huskelisten:   { summary, tools: ['aula.huskelisten.systematic'] }
  },
  usage: {
    cache, nameResolution, pickOne, timeWindows, language
  },
  rawRequestEnabled: false
}
```

`capabilities[area].tools[0]` er altid det rigtige tool at kalde — når en skoles widgets detekteres, listes kun den matchende vendor, så agenten ikke famler ud over flere providers. Det inline `usage`-blok fortæller agenten hvordan den skal opføre sig (cache manifestet, fuzzy-match børnenavne, default til Europe/Copenhagen, svar på brugerens sprog).

---

## CLI-kommandoer

```
aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
aula status [--json]
aula whoami [--json]
aula doctor [--json] [--verbose]
aula log [--last N] [--json]
aula transcript {list|view <file>|prune} [--json] [--keep N] [--dry-run]
aula logout
aula --help
```

| Kommando | Hvad den gør |
| -------- | ------------ |
| `aula login` | Kører hele MitID-flowet (APP-metoden er default — scan QR med MitID-appen). Gemmer tokens. `--debug` opfanger en saneret wire-transcript så fejl er diagnoserbare. |
| `aula status` | Viser om der er tokens, deres udløbstid og den aktive identitet. Kontakter ikke netværket. Exit-kode 1 hvis der ingen tokens er. |
| `aula whoami` | Indlæser tokens (refresher hvis nødvendigt), kalder `getProfilesByLogin` + `getProfileContext`. Smoke-test af at hele auth + client-pipelinen virker. |
| `aula doctor` | Kører hvert read-endpoint igennem og rapporterer per-call status med svartid. Det hurtigste "virker det her?"-tjek. `--verbose` dumper wire-transcripten inline ved fejl. |
| `aula log` | Seneste login-forsøg (success/failure, timestamps, fejlklasse). |
| `aula transcript` | Inspicér opfangede `--debug`-transcripts; `prune` beholder de seneste N (default 10). |
| `aula logout` | Sletter de gemte tokens. Krypteringsnøglen beholdes så næste login genbruger den. |

Komplet hjælp med eksempler: `pnpm aula --help`

![aula --help](./docs/demos/help.gif)

---

## Konfiguration

### Hvor tokens gemmes

| Platform | Default | Override |
| -------- | ------- | -------- |
| macOS | Keychain (`security` CLI; service `aula-mcp`, account `tokens`) | `AULA_MCP_NO_KEYCHAIN=1` falder tilbage til fil-backenden |
| Linux / Windows | AES-256-GCM-krypteret fil i `~/.config/aula-mcp/tokens.json` | `AULA_MCP_KEY=<hex|passphrase>` for krypteringsnøglen (ellers genereret i `~/.config/aula-mcp/.key`, `chmod 600`) |

### Server-miljøvariabler

| Variabel | Default | Effekt |
| -------- | ------- | ------ |
| `AULA_MCP_PORT` | `7878` | Bind-port. |
| `AULA_MCP_HOST` | `127.0.0.1` | Bind-interface. Nægter ikke-loopback medmindre `AULA_MCP_ALLOW_REMOTE=1`. |
| `AULA_MCP_DIR` | `~/.config/aula-mcp` | Konfig-mappe (fil-backend + transcripts + login-log). |
| `AULA_MCP_RAW=1` | off | Aktiverer `aula.raw_request` escape-hatch-toolet. |
| `AULA_MCP_LOG=1` | off | Verbose console-logs fra auth/client-lagene. |
| `AULA_MCP_ALLOW_REMOTE=1` | off | Tillader at binde til ikke-loopback adresser (fx bag en reverse proxy). |

### Wire-transcripts

`--debug`-tilstand tee'r en JSONL-transcript af hvert HTTP-request/response til `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. Cookies, OAuth/SAML-payloads, MitID-auth-koder, adgangskoder, M1, flowValueProof, `access_token`-query-parameter og andre hemmelige felter bliver alle redaktet (`<redacted N chars>`). Transcripten kan trygt vedhæftes en GitHub-issue.

`aula transcript view <file>` pretty-printer en af dem.

---

## Arkitektur

```
packages/
  aula-auth/    — MitID + 3072-bit SRP-6a + OAuth/SAML-kæde + token-store + wire-trace
  aula-client/  — Aula REST API + version-probing + integrations-plugins
  mcp-server/   — Hono + @modelcontextprotocol/sdk + aula.discover + 11 capability-tools
apps/
  cli/          — aula login/status/whoami/doctor/log/transcript/logout
```

Cross-package-imports bruger workspace-navnet (`@aula-mcp/aula-auth`); Bun resolver `.ts` direkte, så der er intet build-trin i dev. `tsc -p tsconfig.json --noEmit` kører i CI til ren type-checking.

| Lag | Status | Noter |
| --- | ------ | ----- |
| `@aula-mcp/aula-auth` | ✅ unit-testet + live-verificeret | MitID APP + CODE_TOKEN + PASSWORD; macOS Keychain eller AES-GCM-fil. |
| `@aula-mcp/aula-client` | ✅ unit-testet | Native Aula API + EasyIQ / EasyIQ SkolePortal / Meebook / Min Uddannelse / Systematic-plugins. |
| `@aula-mcp/mcp-server` | ✅ unit-testet + live-verificeret med Claude Code | Streamable HTTP-transport, stateful session. Single-user, loopback by default. |
| `apps/cli` | ✅ unit-testet | QR-rendering, debug-transcripts, JSONL login-log. |

`@aula-mcp/aula-auth` og `@aula-mcp/aula-client` bruger kun Web-standarder + `node:crypto` + `node:child_process` — de kører på Node ≥ 20 såvel som Bun. MCP-serveren bruger `Bun.serve` og er Bun-only. CLI'en bruger Bun's TS-support og shipper via `bun build --compile`. For at bruge libraries fra et Node-script, se [`examples/script/`](./examples/script/).

Detaljeret design-rationale: [docs/architecture.md](./docs/architecture.md).

---

## Rettelser fra Aula-issues

Et par issues fra `scaarup/aula`s tracker som jeg har taget højde for:

| Upstream issue / PR | Hvad koden gør |
| ------------------- | ----------- |
| [#311](https://github.com/scaarup/aula/issues/311) — sensor dør når widget-JWT'en udløber | `WidgetTokenManager.withRetry` detekterer `{"message":"JWT-Token expired..."}` (samt 401/403) og refresher én gang før retry. |
| [#246, #248](https://github.com/scaarup/aula/issues/246) — Aula API-version drifter (v22 → v23 mid-life) | `AulaClient` prober versioner lazily, retry én gang ved 410, kalder `onApiVersionChanged` ved bumps. |
| [#310](https://github.com/scaarup/aula/issues/310) — RelayState mangler i Level-3 SAML-svar | `extractSamlForm` returnerer `hadRelayState: false` og en tom string i stedet for at kaste. |
| [#306, #287](https://github.com/scaarup/aula/issues/306) — `post-broker-login` returnerer 200 med bekræftelses-form i stedet for 302 | `detectConfirmationForm` finder `button#confirmation-button`, submitter dens form og fortsætter. |
| [#290, #351](https://github.com/scaarup/aula/issues/351) — `password`/`token` krævet for auth-metoder der ikke har brug for det | `AulaLoginOptions` kræver kun felter pr. valgt `method`. APP-metoden skal ikke have password. |
| [PR #352](https://github.com/scaarup/aula/pull/352) — EasyIQ SkolePortal (widget 0128) | Implementeret som `EasyIqSkoleportalClient` + `aula.ugeplan.easyiq_skoleportal` MCP-tool. Per-barn auth + dansk-entity-decode. |
| Følsomme beskeder (`status.code` 403) | Surfaced som typed `AulaStepUpRequiredError`; MCP-tool returnerer struktureret `step_up_required` JSON i stedet for tomme data. |

---

## Fejlfinding

| Symptom | Sandsynlig årsag / fix |
| ------- | ---------------------- |
| `aula login` hænger efter username-prompt | MitID-appen er ikke åbnet endnu, eller QR-koderne er ikke renderet (terminal for smal). Sørg for at terminalen er ≥ 80 kolonner. |
| `Login failed: MitID initialize failed (status …)` | nemlog-in.mitid.dk er ikke tilgængelig eller returnerede en fejl. Kør igen med `--debug` og inspicér transcripten. |
| `Login failed: APP poll error: …` | MitID-appen afviste eller annullerede. Tjek at MitID-appen er logget ind på din konto. |
| `Login failed: appProve failed (status …)` | Sjælden — MitID afviste SRP-proof'et. Kør igen med `--debug` og inspicér `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. |
| `aula whoami` → `step_up_required` for beskeder | En specifik tråd er følsom (Aula returnerer 403). Kør `aula login` igen for at re-etablere en step-up-session, prøv så igen. |
| `aula doctor` siger `Aula API v22 → 410` | API-versionen er bumpet. Kør `aula doctor` igen — `AulaClient` prober frem og husker. |
| `aula status` viser `expired N min ago` | Tokens er udløbet siden sidste brug. Et hvilket som helst read-kald (eller `aula doctor`) refresher dem automatisk. |
| MCP-server: `Refusing to bind to non-loopback address` | Du har sat `AULA_MCP_HOST` til `0.0.0.0` eller lignende. Serveren er single-user; alle der kan ramme `/mcp` bliver dig. Sæt `AULA_MCP_ALLOW_REMOTE=1` hvis du forstår implikationerne. |

Når noget fejler er JSONL-transcripten i `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl` (efter `--debug`) det første sted at kigge. `aula transcript view <file>` pretty-printer den.

---

## Udvikling

```sh
pnpm install          # installér alt
pnpm typecheck        # tsc -p tsconfig.json --noEmit
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # bun:test-suiterne (209 cases)
pnpm test:watch       # re-run ved ændring
```

Alle andre top-level-scripts: `pnpm aula <cmd>`, `pnpm mcp`, plus per-kommando-genvejene (`pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`).

---

## Bidrag

Se [CONTRIBUTING.md](./CONTRIBUTING.md) for repo-layout, konventioner og en guide til at tilføje integrations-plugins. Bidragydere accepterer at følge [Code of Conduct](./CODE_OF_CONDUCT.md). Sikkerhedsproblemer: skriv venligst til **info@casperjuel.dk** i stedet for at åbne en offentlig issue — se [SECURITY.md](./SECURITY.md).

---

## Privatliv & jura

MitID-credentials og OAuth-tokens bliver på din maskine. Serveren binder kun til `localhost` som default. Ingen telemetri. Wire-tracen er opt-in (`--debug`) og hvert kendt-hemmeligt felt redaktes inden noget skrives til disk.

Selve dataen (beskeder, ugeplaner, børnenavne osv.) går videre til den MCP-klient du tilkobler. Hvor klienten sender den hen er klientens sag, ikke serverens — se top-disclaimeren.

Brug projektet til dine egne børns data — log ind som dig selv med din egen MitID; brug det ikke til at tilgå nogen andens konto.

> **Forbehold.** Dette projekt er ikke tilknyttet, godkendt af eller sponsoreret af KMD A/S, Netcompany A/S eller Aula-konsortiet. *Aula* er et varemærke tilhørende sin respektive ejer; navnet bruges her udelukkende til at identificere hvad denne software taler med.

---

## Licens

[MIT](./LICENSE).
