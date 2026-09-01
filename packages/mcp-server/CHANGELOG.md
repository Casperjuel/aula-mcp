# Changelog

## [1.4.0](https://github.com/Casperjuel/aula-mcp/compare/v1.3.0...v1.4.0) (2026-08-31)


### Features

* **mcp:** add aula.messages.mark_read and surface thread pagination ([#81](https://github.com/Casperjuel/aula-mcp/issues/81)) ([c2e5ee5](https://github.com/Casperjuel/aula-mcp/commit/c2e5ee583d912cafa55b1f4da9958e15702f3b13))
* **mcp:** family-wide posts feed, attachment download and PDF text extraction ([#39](https://github.com/Casperjuel/aula-mcp/issues/39)) ([1013d27](https://github.com/Casperjuel/aula-mcp/commit/1013d273db6465d55d2701655ec301427cb780bf)), closes [#75](https://github.com/Casperjuel/aula-mcp/issues/75)
* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))
* **presence:** report a child sick, or take it back ([#59](https://github.com/Casperjuel/aula-mcp/issues/59)) ([f7e5ebf](https://github.com/Casperjuel/aula-mcp/commit/f7e5ebf267d08926c9860e5f085d3f20bf67848d))


### Bug Fixes

* correct AulaProfile field names, and probe a widget the profile has ([#68](https://github.com/Casperjuel/aula-mcp/issues/68)) ([d7a006b](https://github.com/Casperjuel/aula-mcp/commit/d7a006be333af2255be78c7aab2f88cd599e05ea))
* **mcp-server:** set idleTimeout on the setup UI server ([#61](https://github.com/Casperjuel/aula-mcp/issues/61)) ([8be78ac](https://github.com/Casperjuel/aula-mcp/commit/8be78aca80e30e9a842eca326f918caf9a7dc8be))
* **mcp-server:** stop mangling Danish letters in attachment filenames ([#91](https://github.com/Casperjuel/aula-mcp/issues/91)) ([f359252](https://github.com/Casperjuel/aula-mcp/commit/f359252d82916e12a725e93ad47b4bfbf44d0349))
* **mcp-server:** support multiple streamable HTTP MCP sessions ([#79](https://github.com/Casperjuel/aula-mcp/issues/79)) ([32a40bd](https://github.com/Casperjuel/aula-mcp/commit/32a40bd75f982f4ec981ce96a19fce080a2c8f54))
* **mcp-server:** use institution profile IDs for calendar events ([#82](https://github.com/Casperjuel/aula-mcp/issues/82)) ([21a23fd](https://github.com/Casperjuel/aula-mcp/commit/21a23fd1548a464c79cbb4806ccc8a0ee1d9be20))

## [1.3.0](https://github.com/Casperjuel/aula-mcp/compare/v1.2.0...v1.3.0) (2026-08-14)


### Features

* **presence:** report a child sick, or take it back ([#59](https://github.com/Casperjuel/aula-mcp/issues/59)) ([f7e5ebf](https://github.com/Casperjuel/aula-mcp/commit/f7e5ebf267d08926c9860e5f085d3f20bf67848d))


### Bug Fixes

* **mcp-server:** set idleTimeout on the setup UI server ([#61](https://github.com/Casperjuel/aula-mcp/issues/61)) ([8be78ac](https://github.com/Casperjuel/aula-mcp/commit/8be78aca80e30e9a842eca326f918caf9a7dc8be))

## [1.2.0](https://github.com/Casperjuel/aula-mcp/compare/v1.1.0...v1.2.0) (2026-05-22)


### Features

* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))

## [1.1.0](https://github.com/Casperjuel/aula-mcp/compare/v1.0.0...v1.1.0) (2026-05-13)


### Features

* **ha-addon:** in-addon MitID login UI via HA Ingress ([#20](https://github.com/Casperjuel/aula-mcp/issues/20)) ([3899ab5](https://github.com/Casperjuel/aula-mcp/commit/3899ab561a50a0833a3085c2d073561f3c3702d8))
* **mcp-server:** add legacy SSE transport for Home Assistant compatibility ([#18](https://github.com/Casperjuel/aula-mcp/issues/18)) ([e6af96d](https://github.com/Casperjuel/aula-mcp/commit/e6af96d181a73c4537bbd0c19b9842bacd3a4f1b))


### Bug Fixes

* **mcp-server:** cap + idle-evict SSE sessions, validate inbound JSON-RPC ([#21](https://github.com/Casperjuel/aula-mcp/issues/21)) ([6f7f003](https://github.com/Casperjuel/aula-mcp/commit/6f7f003041f7dbd3dbcf7c817d83ed653427584d))

## 1.0.0 (2026-05-13)


### Features

* **aula-client:** integration plugins (EasyIQ, Meebook, Min Uddannelse, Systematic) ([26a6798](https://github.com/Casperjuel/aula-mcp/commit/26a6798a641fb15784bd29c385c6eab7f00d5594))
* **cli:** aula doctor + transcript view/list/prune + --json + prompt timeout + locale cleanup ([25351c3](https://github.com/Casperjuel/aula-mcp/commit/25351c32671431136c40d9bffc423a32584b1518))
* **integrations:** add EasyIQ Lektier widget (0142) ([#8](https://github.com/Casperjuel/aula-mcp/issues/8)) ([106f4c8](https://github.com/Casperjuel/aula-mcp/commit/106f4c80da1eea050ce89f135876209481d0e366))
* **integrations:** EasyIQ SkolePortal (widget 0128, PR scaarup/aula[#352](https://github.com/Casperjuel/aula-mcp/issues/352)) ([e754f1b](https://github.com/Casperjuel/aula-mcp/commit/e754f1b954dd1e7c9aaec4c66cc4b38ce7795c21))
* **mcp-server:** Hono + Streamable HTTP + aula.discover ([2466d2f](https://github.com/Casperjuel/aula-mcp/commit/2466d2f71f2ee0c5d5992d8748d27dc3cc516918))
* **mcp:** widget detection, friendly calendar range, raw escape hatch, notifications + posts tools ([1ec1a5f](https://github.com/Casperjuel/aula-mcp/commit/1ec1a5f4aa3bddeec8187a054df7a7b56f62b2fd))


### Bug Fixes

* **auth-correctness:** meta-refresh fallback, refresh race, fetch errors, cookie warnings, graceful shutdown, remote-bind guard ([e337e77](https://github.com/Casperjuel/aula-mcp/commit/e337e7744840a35df70563207b287ca06e0fed31))
* critical issues from gap review ([53a9ea4](https://github.com/Casperjuel/aula-mcp/commit/53a9ea4c86b8fb2c22b65614c5a71442ebc2e443))
* **login,mcp:** unblock end-to-end auth + ugeplan, sharpen MCP UX ([f711ca4](https://github.com/Casperjuel/aula-mcp/commit/f711ca4b48ff495459c15f8b2b8dda838880e01e))
