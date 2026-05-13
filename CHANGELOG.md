# Changelog

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
