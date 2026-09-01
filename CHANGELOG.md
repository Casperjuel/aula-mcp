# Changelog

## [1.5.1](https://github.com/Casperjuel/aula-mcp/compare/v1.5.0...v1.5.1) (2026-09-01)


### Bug Fixes

* **ci:** release one version, and report it in the MCP handshake ([#94](https://github.com/Casperjuel/aula-mcp/issues/94)) ([71a124a](https://github.com/Casperjuel/aula-mcp/commit/71a124a79319fd3fd51c3a54f59d64b3a7f04843))

## [1.5.0](https://github.com/Casperjuel/aula-mcp/compare/v1.4.0...v1.5.0) (2026-08-31)


### Features

* **cli:** add `aula notifications list-ids` for no-LLM Overblik pre-check ([#78](https://github.com/Casperjuel/aula-mcp/issues/78)) ([5fbfbc7](https://github.com/Casperjuel/aula-mcp/commit/5fbfbc7b31244a5c6c445fe71bfc6df714bd007d))
* **mcp:** add aula.messages.mark_read and surface thread pagination ([#81](https://github.com/Casperjuel/aula-mcp/issues/81)) ([c2e5ee5](https://github.com/Casperjuel/aula-mcp/commit/c2e5ee583d912cafa55b1f4da9958e15702f3b13))
* **mcp:** family-wide posts feed, attachment download and PDF text extraction ([#39](https://github.com/Casperjuel/aula-mcp/issues/39)) ([1013d27](https://github.com/Casperjuel/aula-mcp/commit/1013d273db6465d55d2701655ec301427cb780bf)), closes [#75](https://github.com/Casperjuel/aula-mcp/issues/75)


### Bug Fixes

* **auth:** name STIL's bot-defense block instead of "unexpected host" ([#88](https://github.com/Casperjuel/aula-mcp/issues/88)) ([835960b](https://github.com/Casperjuel/aula-mcp/commit/835960b4cfb372e7836719b52dc89b8ca1f25ae2)), closes [#83](https://github.com/Casperjuel/aula-mcp/issues/83)
* **auth:** redact access_token and OAuth codes from logs and errors ([#90](https://github.com/Casperjuel/aula-mcp/issues/90)) ([93bcd16](https://github.com/Casperjuel/aula-mcp/commit/93bcd161a62e6f146863adcf708cb972dcee430a)), closes [#86](https://github.com/Casperjuel/aula-mcp/issues/86)
* **client:** establish profile context before the first POST ([#80](https://github.com/Casperjuel/aula-mcp/issues/80)) ([24f9dec](https://github.com/Casperjuel/aula-mcp/commit/24f9dec36fb92523c6cb2026ea8b564bbf14c4f0))
* **cli:** keep JSON-only command output parseable on failure ([#85](https://github.com/Casperjuel/aula-mcp/issues/85)) ([e1dca9b](https://github.com/Casperjuel/aula-mcp/commit/e1dca9b04315f73eae5dfcc10083b6bebce4f9c1))
* **cli:** tell the user to open the MitID app while waiting ([#67](https://github.com/Casperjuel/aula-mcp/issues/67)) ([5a22968](https://github.com/Casperjuel/aula-mcp/commit/5a22968e7864f7d4dcd499a74701059d9ec14acf))
* correct AulaProfile field names, and probe a widget the profile has ([#68](https://github.com/Casperjuel/aula-mcp/issues/68)) ([d7a006b](https://github.com/Casperjuel/aula-mcp/commit/d7a006be333af2255be78c7aab2f88cd599e05ea))
* **mcp-server:** stop mangling Danish letters in attachment filenames ([#91](https://github.com/Casperjuel/aula-mcp/issues/91)) ([f359252](https://github.com/Casperjuel/aula-mcp/commit/f359252d82916e12a725e93ad47b4bfbf44d0349))
* **mcp-server:** support multiple streamable HTTP MCP sessions ([#79](https://github.com/Casperjuel/aula-mcp/issues/79)) ([32a40bd](https://github.com/Casperjuel/aula-mcp/commit/32a40bd75f982f4ec981ce96a19fce080a2c8f54))
* **mcp-server:** use institution profile IDs for calendar events ([#82](https://github.com/Casperjuel/aula-mcp/issues/82)) ([21a23fd](https://github.com/Casperjuel/aula-mcp/commit/21a23fd1548a464c79cbb4806ccc8a0ee1d9be20))
* **minuddannelse:** key childFilter on unilogin userIds, not numeric profile ids ([#87](https://github.com/Casperjuel/aula-mcp/issues/87)) ([6a9f91a](https://github.com/Casperjuel/aula-mcp/commit/6a9f91a516dc0340c671c3f63ac36f84db0e8fd7)), closes [#74](https://github.com/Casperjuel/aula-mcp/issues/74)

## [1.4.0](https://github.com/Casperjuel/aula-mcp/compare/v1.3.0...v1.4.0) (2026-08-14)


### Features

* **presence:** report a child sick, or take it back ([#59](https://github.com/Casperjuel/aula-mcp/issues/59)) ([f7e5ebf](https://github.com/Casperjuel/aula-mcp/commit/f7e5ebf267d08926c9860e5f085d3f20bf67848d))


### Bug Fixes

* **mcp-server:** set idleTimeout on the setup UI server ([#61](https://github.com/Casperjuel/aula-mcp/issues/61)) ([8be78ac](https://github.com/Casperjuel/aula-mcp/commit/8be78aca80e30e9a842eca326f918caf9a7dc8be))
* pnpm login/logout/doctor/whoami collide with pnpm builtins ([#63](https://github.com/Casperjuel/aula-mcp/issues/63)) ([a0dd3aa](https://github.com/Casperjuel/aula-mcp/commit/a0dd3aa5e8813dbae3199a6f5037b7e956c0f31a))

## [1.3.0](https://github.com/Casperjuel/aula-mcp/compare/v1.2.0...v1.3.0) (2026-06-09)


### Features

* **cli:** add `aula ugeplan fetch` for no-LLM week-plan pre-check ([#40](https://github.com/Casperjuel/aula-mcp/issues/40)) ([0a2ba72](https://github.com/Casperjuel/aula-mcp/commit/0a2ba721f96980db0110faedcc9af3e8589af728))


### Bug Fixes

* **auth,meebook:** support MitID hardware kodeviser + fix dup identities & Meebook unilogin ([#42](https://github.com/Casperjuel/aula-mcp/issues/42)) ([1c37582](https://github.com/Casperjuel/aula-mcp/commit/1c3758220839dee0a9da259c115859d0b1e2a52f))

## [1.2.0](https://github.com/Casperjuel/aula-mcp/compare/v1.1.0...v1.2.0) (2026-05-22)


### Features

* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))

## [1.1.0](https://github.com/Casperjuel/aula-mcp/compare/v1.0.1...v1.1.0) (2026-05-13)


### Features

* **ha-addon:** Home Assistant add-on packaging ([#19](https://github.com/Casperjuel/aula-mcp/issues/19)) ([2da9135](https://github.com/Casperjuel/aula-mcp/commit/2da91359b55f50584ceba35e8d5d9b12cd84c21f))
* **ha-addon:** in-addon MitID login UI via HA Ingress ([#20](https://github.com/Casperjuel/aula-mcp/issues/20)) ([3899ab5](https://github.com/Casperjuel/aula-mcp/commit/3899ab561a50a0833a3085c2d073561f3c3702d8))
* **mcp-server:** add legacy SSE transport for Home Assistant compatibility ([#18](https://github.com/Casperjuel/aula-mcp/issues/18)) ([e6af96d](https://github.com/Casperjuel/aula-mcp/commit/e6af96d181a73c4537bbd0c19b9842bacd3a4f1b))


### Bug Fixes

* **mcp-server:** cap + idle-evict SSE sessions, validate inbound JSON-RPC ([#21](https://github.com/Casperjuel/aula-mcp/issues/21)) ([6f7f003](https://github.com/Casperjuel/aula-mcp/commit/6f7f003041f7dbd3dbcf7c817d83ed653427584d))

## [1.0.1](https://github.com/Casperjuel/aula-mcp/compare/v1.0.0...v1.0.1) (2026-05-13)


### Bug Fixes

* **release:** wire PAT for release-please + workflow_dispatch on release ([#16](https://github.com/Casperjuel/aula-mcp/issues/16)) ([a3021a7](https://github.com/Casperjuel/aula-mcp/commit/a3021a79c05621f96482f9a24025bee33d06322b))

## 1.0.0 (2026-05-13)


### Features

* **aula-auth:** foundation utilities (HTTP, crypto, cookies, HTML, PKCE) ([b2678e1](https://github.com/Casperjuel/aula-mcp/commit/b2678e14d38c82cf557139d0ceeb06a8c8750b73))
* **aula-auth:** port CustomSRP-6a (3072-bit) with golden vectors ([08d3d67](https://github.com/Casperjuel/aula-mcp/commit/08d3d67d2ab5f65f2b54ba502610931eaab0a473))
* **aula-auth:** port MitidClient (APP + CODE_TOKEN + PASSWORD) ([5ac5f15](https://github.com/Casperjuel/aula-mcp/commit/5ac5f159b8c420c5bd1ae0d086196a33944c1330))
* **aula-auth:** port OAuth + SAML/broker handoff + AulaLoginClient ([596daf4](https://github.com/Casperjuel/aula-mcp/commit/596daf4f09de23564ad3d8771aad95770186fe0b))
* **aula-auth:** token store + wire-trace debug tooling ([d7a7228](https://github.com/Casperjuel/aula-mcp/commit/d7a7228637919fc86c17c407e18c081176269b41))
* **aula-client:** API version probing + core endpoints + widget token manager ([d8c7c9f](https://github.com/Casperjuel/aula-mcp/commit/d8c7c9f76c2808daddfc4526973d72a11db8edd6))
* **aula-client:** integration plugins (EasyIQ, Meebook, Min Uddannelse, Systematic) ([26a6798](https://github.com/Casperjuel/aula-mcp/commit/26a6798a641fb15784bd29c385c6eab7f00d5594))
* **auth:** legacy MitID /prove + /verify fallback (J3) ([af05323](https://github.com/Casperjuel/aula-mcp/commit/af0532372cba69f7b7a27f4ec207cdc86f49cfbe))
* **ci:** automated semver via release-please ([dd38143](https://github.com/Casperjuel/aula-mcp/commit/dd381431d6ac27833bf978fad6ac5b0c1b03cb04))
* **cli:** aula doctor + transcript view/list/prune + --json + prompt timeout + locale cleanup ([25351c3](https://github.com/Casperjuel/aula-mcp/commit/25351c32671431136c40d9bffc423a32584b1518))
* **cli:** aula login / status / whoami / logout ([8b8c5c4](https://github.com/Casperjuel/aula-mcp/commit/8b8c5c4e5250413ec1c5568774d4c56d8f10f9f5))
* **cli:** aula tokens export/import for self-host migration ([03852f5](https://github.com/Casperjuel/aula-mcp/commit/03852f5de3ba83db36e80aaa8f920189e32f28df))
* **integrations:** add EasyIQ Lektier widget (0142) ([#8](https://github.com/Casperjuel/aula-mcp/issues/8)) ([106f4c8](https://github.com/Casperjuel/aula-mcp/commit/106f4c80da1eea050ce89f135876209481d0e366))
* **integrations:** EasyIQ SkolePortal (widget 0128, PR scaarup/aula[#352](https://github.com/Casperjuel/aula-mcp/issues/352)) ([e754f1b](https://github.com/Casperjuel/aula-mcp/commit/e754f1b954dd1e7c9aaec4c66cc4b38ce7795c21))
* macOS Keychain backend (Q4) + login activity log (F7) + nightly canary (W6) ([10d09d6](https://github.com/Casperjuel/aula-mcp/commit/10d09d624a6f0b9d1ba607486a95114245d918e7))
* **mcp-server:** Hono + Streamable HTTP + aula.discover ([2466d2f](https://github.com/Casperjuel/aula-mcp/commit/2466d2f71f2ee0c5d5992d8748d27dc3cc516918))
* **mcp:** widget detection, friendly calendar range, raw escape hatch, notifications + posts tools ([1ec1a5f](https://github.com/Casperjuel/aula-mcp/commit/1ec1a5f4aa3bddeec8187a054df7a7b56f62b2fd))
* **mitid:** typed CAP008 'parallel sessions' error + CLI hint + log footer ([61945aa](https://github.com/Casperjuel/aula-mcp/commit/61945aa948d67bf1078aa3c983719bd8e76c37bc))


### Bug Fixes

* **auth-correctness:** meta-refresh fallback, refresh race, fetch errors, cookie warnings, graceful shutdown, remote-bind guard ([e337e77](https://github.com/Casperjuel/aula-mcp/commit/e337e7744840a35df70563207b287ca06e0fed31))
* **canary:** treat 403 from Aula edge as filter, require 2 consecutive fails before paging ([#12](https://github.com/Casperjuel/aula-mcp/issues/12)) ([0c68ab8](https://github.com/Casperjuel/aula-mcp/commit/0c68ab883e777add4a99201ba6fe209d79463f7c))
* critical issues from gap review ([53a9ea4](https://github.com/Casperjuel/aula-mcp/commit/53a9ea4c86b8fb2c22b65614c5a71442ebc2e443))
* **login,mcp:** unblock end-to-end auth + ugeplan, sharpen MCP UX ([f711ca4](https://github.com/Casperjuel/aula-mcp/commit/f711ca4b48ff495459c15f8b2b8dda838880e01e))
* **mitid:** auto-fall-back from /complete to /prove+/verify on 404 ([82d715d](https://github.com/Casperjuel/aula-mcp/commit/82d715d56e4954ba4952fe454f74d780270abdbb))
* **mitid:** handle double-JSON-encoded /initialize response ([1ecd8ce](https://github.com/Casperjuel/aula-mcp/commit/1ecd8ce69d6b0c59df5c7e3c39924649ec0a26bf))
