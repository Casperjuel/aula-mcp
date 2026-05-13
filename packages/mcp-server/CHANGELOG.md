# Changelog

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
