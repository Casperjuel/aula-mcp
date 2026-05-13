# aula-mcp i Home Assistant

End-to-end-guide til at få Aula til at tale med HA's **Assist**-stemmeassistent.
Når det her er sat op, kan du spørge ind på dansk (med stemme eller skrift) og
få svar baseret på rigtige Aula-data:

> *"Hvad er lektien i dag for Emilie?"*
> *"Læs de nyeste beskeder fra skolen højt."*
> *"Hvad står der i ugeplanen næste uge?"*

> ⚠️ **Datasti — vigtig at forstå før du går i gang**
>
> Selve `aula-mcp`-add-on'en sender ikke data ud af din HA. Men HA's *Assist*
> agent skal bruge en LLM, og **alt det LLM'en læser sendes til den provider
> du vælger** (Anthropic / OpenAI / Google → cloud i USA; Ollama / llama.cpp /
> Local AI → forbliver lokalt). MitID-credentials og OAuth-tokens forlader
> aldrig din HA. Læs disclaimeren i [hovedet af README'en](../README.md) før
> du kobler en cloud-LLM på dine børns skoledata.

---

## Indhold

1. [Forudsætninger](#forudsætninger)
2. [Installer add-on'en](#installer-add-onen)
3. [Log ind med MitID](#log-ind-med-mitid)
4. [Tilslut HA's MCP-klient integration](#tilslut-has-mcp-klient-integration)
5. [Vælg LLM til Assist](#vælg-llm-til-assist)
6. [Stemmeintegration (valgfrit)](#stemmeintegration-valgfrit)
7. [Prøv det](#prøv-det)
8. [Fejlfinding](#fejlfinding)

---

## Forudsætninger

- **Home Assistant OS, Supervised eller Container med Supervisor**. HA Core
  alene har ikke add-on store. Tjek Settings → System → About — du skal kunne
  se *Supervisor* listet.
- **HA 2025.2 eller nyere** — det er den release hvor MCP-integrationen
  landede ind i core.
- **En LLM-provider** — Anthropic-API-nøgle, OpenAI-API-nøgle, eller en
  selvhostet Ollama. Du bliver bedt om at vælge senere.
- **MitID-app på din telefon** — selve godkendelsen er stadig MitID's
  almindelige QR-scanning, intet bypass.
- **Aula-konto** — tokens kan kun hentes for én forælder ad gangen; del med
  resten af husstanden via Voice senere.

Hardware-mæssigt kører add-on'en fint på en Raspberry Pi 4/5, en Intel NUC,
eller hvad du nu kører HA på. Første build af add-on-imaget tager 1-2
minutter på en Pi.

---

## Installer add-on'en

### Et-klik

[![Open your Home Assistant instance and add the aula-mcp add-on repository.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/Casperjuel/aula-mcp)

Klik badget → HA åbner "Add repository"-dialogen med URL'en pre-udfyldt.

### Eller manuelt

1. Settings → **Add-ons** → **Add-on Store**.
2. Trepunkts-menuen (øverst til højre) → **Repositories**.
3. Indsæt `https://github.com/Casperjuel/aula-mcp` → **Add**.

Når repository'et er tilføjet:

4. Bladr ned til **aula-mcp add-ons** sektionen i Add-on Store.
5. Klik **aula-mcp** → **Install**. Supervisor bygger imaget lokalt (tager
   1-2 min på en Pi).
6. **Start ikke add-on'en endnu** — log først ind (næste sektion).

---

## Log ind med MitID

aula-mcp gemmer OAuth-tokens lokalt i `/config/aula-mcp/` (krypteret med
AES-256-GCM). Tokens hentes via MitID-flow'et én gang; refresh sker derefter
automatisk så længe Aula accepterer det.

Der er to måder at logge ind på:

### Måde 1: Add-on'ens egen login-UI (anbefalet)

Den nemmeste — alt sker inde i HA.

1. **Start add-on'en** fra dens side i Add-on Store.
2. Et nyt punkt **aula-mcp** dukker op i HA's sidebar (klap eventuelt
   sidebaren ud i bunden).
3. Klik **aula-mcp**. Du ser *"Ikke logget ind"*.
4. Skriv dit **MitID-brugernavn** og klik **Start login**.
5. To QR-koder dukker op (de skifter automatisk — det er MitID's anti-phishing
   tjek). Åbn **MitID-appen** på din telefon, scan en af dem.
6. Godkend login i MitID-appen.
7. Hvis du har flere identiteter (typisk forældre med flere log-in-veje),
   vælg den der hører til Aula.
8. Siden flipper til *"Logget ind 🎉"*. Tokens er gemt; access-token udløb
   står på siden.

Login-flow'et kører lokalt i din HA-installation. MitID-godkendelsen sker
mellem MitID-appen og nemlog-in.dk. Add-on'en ser kun de tokens du får
tilbage.

### Måde 2: Workstation-eksport (fallback)

Hvis du ikke vil skrive MitID-brugernavn ind i HA's UI (eller har brug for at
gentage det programmatisk fra en server uden browser), kan du logge ind på en
workstation og kopiere bundle'en:

```sh
git clone https://github.com/Casperjuel/aula-mcp.git && cd aula-mcp
pnpm install
pnpm login                              # MitID QR-flow på workstation
pnpm aula tokens export ./aula-bundle   # → aula-bundle/tokens.json + .key
```

Kopiér de to filer ind i HA's `/config/aula-mcp/`:

```sh
# SSH'd HA (Studio Code Server add-on eller File editor add-on virker også)
scp aula-bundle/tokens.json aula-bundle/.key homeassistant:/config/aula-mcp/
```

Genstart add-on'en. Bundle'en er bytte-bar — næste login via UI'en
overskriver bare hvad der lå før.

---

## Tilslut HA's MCP-klient integration

HA's officielle [`mcp` (client) integration](https://www.home-assistant.io/integrations/mcp/)
sender de værktøjer aula-mcp eksponerer videre til den konversationsagent
(LLM) du vælger.

1. Settings → **Devices & Services** → **Add Integration**.
2. Søg efter **Model Context Protocol** → vælg den.
3. **SSE Server URL:** `http://homeassistant.local:7878/sse`
   - Hvis din HA ikke svarer på `homeassistant.local` (statisk IP, anden
     hostname): brug HA's IP-adresse, fx `http://192.168.1.50:7878/sse`.
4. **Submit**. HA opdager `aula.*`-værktøjerne automatisk.

Tjek at det virker: Settings → Devices & Services → klik på **Model Context
Protocol** integrationen. Du burde se en liste med værktøjer som
`aula.discover`, `aula.ugeplan.easyiq`, `aula.lektier.easyiq`,
`aula.messages.list`, osv.

> 📝 Hvis HA's MCP-klient integration **ikke kan oprette forbindelse**, tjek
> at add-on'en kører og at `allow_remote: true` er sat i dens config
> (default). Se [Fejlfinding](#fejlfinding) nedenfor.

---

## Vælg LLM til Assist

Assist-pipelinen sender brugerens spørgsmål videre til den
konversationsagent du har valgt. Agenten ser HA's egne entiteter **plus** de
`aula.*`-værktøjer MCP-integrationen lige har registreret.

### Valg af agent

Vælg én — du kan altid skifte senere.

| Agent | Hvor kører LLM'en | Pris | Note |
| --- | --- | --- | --- |
| **Anthropic** (Claude) | Cloud (Anthropic, USA) | Pay-per-token | Aktuelt det bedste valg til at vælge værktøjer korrekt + svare på dansk. Default-anbefaling i denne guide. |
| **OpenAI** (GPT-4o / GPT-4.1) | Cloud (OpenAI, USA) | Pay-per-token | Også fint; lidt mere variabel på dansk grammatik. |
| **Google Gemini** | Cloud (Google) | Pay-per-token | Virker, men har historisk haft sjuskede tool-calls. |
| **Ollama / lokal LLM** | Din HA-host eller en GPU-maskine på LAN | Gratis (CPU/GPU-strøm) | 100% lokal sti; kvaliteten afhænger af modellen — `llama3.1:8b` eller `qwen2.5:14b` er rimelige til danske tool-calls. |

### Opsætning

1. Settings → **Devices & Services** → **Add Integration** → vælg fx
   **Anthropic Conversation** (eller den agent du har valgt).
2. Indsæt API-nøgle. For Anthropic: lav en på
   [console.anthropic.com](https://console.anthropic.com/).
3. **Submit**.
4. Settings → **Voice assistants** → **Add assistant** → giv den et navn,
   fx *Aula*.
5. **Conversation agent:** vælg den agent du lige tilføjede.
6. **Speech-to-text** og **Text-to-speech:** se næste sektion (kan også være
   "none" hvis du kun vil bruge skrift).
7. **Save**.

---

## Stemmeintegration (valgfrit)

Hvis du kun vil chatte med Assist via skriftlig prompt, er du færdig. For at
få fuld stemmeintegration ("hey, hvad er lektien i dag?"), tilføj følgende
til samme assistent-konfiguration:

- **Speech-to-text:** [Whisper](https://www.home-assistant.io/integrations/whisper/)
  add-on'en (lokal STT) eller HA Cloud's STT.
- **Text-to-speech:** [Piper](https://www.home-assistant.io/integrations/piper/)
  add-on'en med en dansk stemme (`da_DK-talesyntese`) eller HA Cloud's TTS.
- **Wake word:** [OpenWakeWord](https://www.home-assistant.io/integrations/wyoming/)
  add-on'en, eller en *Home Assistant Voice Preview Edition*-enhed der har
  wake-word indbygget.

Konfigurér derefter en wake-word-enhed (HA Voice PE, en ESP32-S3 box, eller
en mobil-app i Assist-mode) til at bruge **Aula** som standard pipeline.

> 💬 **Tip:** Piper's danske stemmer er ikke perfekte, men de er
> *forståelige*. HA Cloud's TTS (kræver Nabu Casa-abonnement) lyder
> mærkbart bedre på dansk.

---

## Prøv det

Settings → **Voice assistants** → din *Aula*-assistent → **Try it**.

Skriv eller sig på dansk:

> *Hvad står der på ugeplanen for [barnets navn] næste uge?*

Hvad du burde se i kulisserne:

1. LLM'en kalder `aula.discover` (én gang per session) for at få oversigt
   over dine børn + hvilke widgets skolerne har.
2. LLM'en fuzzy-matcher barnets navn mod manifestet — du behøver ikke skrive
   det perfekt.
3. LLM'en vælger det rigtige ugeplan-værktøj for skolens vendor (EasyIQ,
   Meebook, Min Uddannelse, osv.).
4. Svaret kommer på dansk med dansk-formatterede datoer (*mandag 12. maj*).

Eksempler du kan prøve:

| Prompt | Hvad LLM'en kalder |
| --- | --- |
| *"Hvad er lektien i dag?"* | `aula.lektier.easyiq` (hvis skolen har 0142) eller fallback |
| *"Læs de nyeste beskeder fra skolen op"* | `aula.messages.list` |
| *"Har vi missede notifikationer?"* | `aula.notifications.list` |
| *"Hvad sker der i kalenderen næste uge?"* | `aula.calendar.list` |
| *"Hvad er ugeplanen for [barn] næste uge?"* | `aula.ugeplan.*` (vendor-specifik) |

---

## Fejlfinding

### Add-on'en starter ikke / fejler ved boot

Tjek **Settings → Add-ons → aula-mcp → Log**. Almindelige fejl:

| Log-besked | Årsag | Løsning |
| --- | --- | --- |
| `Refusing to bind to non-loopback address` | `allow_remote: false` + 0.0.0.0 — den nye version af add-on'en har fixet dette, men hvis du kører en gammel version, sæt `allow_remote: true` |
| `EncryptedFileTokenStore: key file not found` | Du har ikke logget ind endnu, eller tokens er slettet | Log ind via add-on-UI'en eller workstation-eksport |
| Container exit code 137 | OOM-killer (typisk på Pi med lidt RAM under første build) | Genstart Supervisor, prøv igen — eller byg på en kraftigere maskine og push imaget |

### HA's MCP-klient siger "Failed to connect"

1. Tjek at add-on'en faktisk kører: Settings → Add-ons → aula-mcp → status
   skal være **Started**.
2. Verificer at port 7878 svarer:
   ```sh
   curl -N http://homeassistant.local:7878/sse
   ```
   Du burde se en `event: endpoint`-linje. Hvis ikke, kører add-on'en ikke
   på den port (tjek Logs).
3. Hvis `homeassistant.local` ikke virker fra din MCP-klient (typisk i
   container-isolerede netværk), brug HA's IP-adresse i stedet.
4. Tjek `allow_remote: true` i add-on-konfigurationen.

### LLM'en finder ikke værktøjerne / svarer ikke om Aula

1. Settings → Devices & Services → **Model Context Protocol** → klik
   integrationen. Står der `aula.*`-værktøjer i listen?
   - Hvis nej: integrationen kunne ikke hente manifest. Tjek add-on-loggen.
2. Settings → Voice assistants → din assistent → konversationsagenten skal
   kunne kalde værktøjer (Anthropic, OpenAI og Gemini kan; nogle Ollama-
   modeller kan ikke).
3. Tjek at LLM-providerens API-nøgle er gyldig + har credit (de fleste
   "værktøjer ikke fundet"-fejl skyldes en udløbet API-nøgle der returnerer
   401, hvilket Assist fortolker sjusket).

### Tokens er udløbet (Aula vil have ny login)

Aula's refresh-token roterer relativt aggressivt. Hvis add-on-loggen viser
401'ere fra Aula:

1. Åbn aula-mcp's sidebar-panel i HA.
2. Klik **Log ud** (hvis du kan se *"Logget ind"*-status).
3. Log ind igen via UI'en — samme flow som første gang.

### "Identity selection timed out"

Du så identitetsvælgeren og lod siden ligge åben i mere end 5 minutter.
Klik **Start login** igen.

---

## Næste skridt

- [README.md](../README.md) — hovedguide, CLI-kommandoer, arkitektur.
- [homeassistant-addon/README.md](../homeassistant-addon/README.md) —
  add-on-specifikke detaljer + opsætning.
- [docs/architecture.md](./architecture.md) — hvordan auth-laget, MCP-laget
  og vendor-integrationerne hænger sammen.

Hvis du støder på et flow guiden ikke dækker — fx HA Cloud + Nabu Casa-
specifikke ting, eller en Ollama-model der opfører sig mærkeligt på dansk —
[åbn et issue](https://github.com/Casperjuel/aula-mcp/issues) med add-on-
log + et redigeret transcript.
