# Changelog

## [1.4.0](https://github.com/Casperjuel/aula-mcp/compare/v1.3.0...v1.4.0) (2026-08-31)


### Features

* **mcp:** add aula.messages.mark_read and surface thread pagination ([#81](https://github.com/Casperjuel/aula-mcp/issues/81)) ([c2e5ee5](https://github.com/Casperjuel/aula-mcp/commit/c2e5ee583d912cafa55b1f4da9958e15702f3b13))
* **mcp:** family-wide posts feed, attachment download and PDF text extraction ([#39](https://github.com/Casperjuel/aula-mcp/issues/39)) ([1013d27](https://github.com/Casperjuel/aula-mcp/commit/1013d273db6465d55d2701655ec301427cb780bf)), closes [#75](https://github.com/Casperjuel/aula-mcp/issues/75)
* **presence:** report a child sick, or take it back ([#59](https://github.com/Casperjuel/aula-mcp/issues/59)) ([f7e5ebf](https://github.com/Casperjuel/aula-mcp/commit/f7e5ebf267d08926c9860e5f085d3f20bf67848d))


### Bug Fixes

* **auth:** redact access_token and OAuth codes from logs and errors ([#90](https://github.com/Casperjuel/aula-mcp/issues/90)) ([93bcd16](https://github.com/Casperjuel/aula-mcp/commit/93bcd161a62e6f146863adcf708cb972dcee430a)), closes [#86](https://github.com/Casperjuel/aula-mcp/issues/86)
* **client:** establish profile context before the first POST ([#80](https://github.com/Casperjuel/aula-mcp/issues/80)) ([24f9dec](https://github.com/Casperjuel/aula-mcp/commit/24f9dec36fb92523c6cb2026ea8b564bbf14c4f0))
* correct AulaProfile field names, and probe a widget the profile has ([#68](https://github.com/Casperjuel/aula-mcp/issues/68)) ([d7a006b](https://github.com/Casperjuel/aula-mcp/commit/d7a006be333af2255be78c7aab2f88cd599e05ea))
* **minuddannelse:** key childFilter on unilogin userIds, not numeric profile ids ([#87](https://github.com/Casperjuel/aula-mcp/issues/87)) ([6a9f91a](https://github.com/Casperjuel/aula-mcp/commit/6a9f91a516dc0340c671c3f63ac36f84db0e8fd7)), closes [#74](https://github.com/Casperjuel/aula-mcp/issues/74)

## [1.3.0](https://github.com/Casperjuel/aula-mcp/compare/v1.2.1...v1.3.0) (2026-08-14)


### Features

* **aula-auth:** foundation utilities (HTTP, crypto, cookies, HTML, PKCE) ([b2678e1](https://github.com/Casperjuel/aula-mcp/commit/b2678e14d38c82cf557139d0ceeb06a8c8750b73))
* **aula-client:** API version probing + core endpoints + widget token manager ([d8c7c9f](https://github.com/Casperjuel/aula-mcp/commit/d8c7c9f76c2808daddfc4526973d72a11db8edd6))
* **aula-client:** integration plugins (EasyIQ, Meebook, Min Uddannelse, Systematic) ([26a6798](https://github.com/Casperjuel/aula-mcp/commit/26a6798a641fb15784bd29c385c6eab7f00d5594))
* **integrations:** add EasyIQ Lektier widget (0142) ([#8](https://github.com/Casperjuel/aula-mcp/issues/8)) ([106f4c8](https://github.com/Casperjuel/aula-mcp/commit/106f4c80da1eea050ce89f135876209481d0e366))
* **integrations:** EasyIQ SkolePortal (widget 0128, PR scaarup/aula[#352](https://github.com/Casperjuel/aula-mcp/issues/352)) ([e754f1b](https://github.com/Casperjuel/aula-mcp/commit/e754f1b954dd1e7c9aaec4c66cc4b38ce7795c21))
* **mcp:** widget detection, friendly calendar range, raw escape hatch, notifications + posts tools ([1ec1a5f](https://github.com/Casperjuel/aula-mcp/commit/1ec1a5f4aa3bddeec8187a054df7a7b56f62b2fd))
* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))
* **presence:** report a child sick, or take it back ([#59](https://github.com/Casperjuel/aula-mcp/issues/59)) ([f7e5ebf](https://github.com/Casperjuel/aula-mcp/commit/f7e5ebf267d08926c9860e5f085d3f20bf67848d))


### Bug Fixes

* **auth,meebook:** support MitID hardware kodeviser + fix dup identities & Meebook unilogin ([#42](https://github.com/Casperjuel/aula-mcp/issues/42)) ([1c37582](https://github.com/Casperjuel/aula-mcp/commit/1c3758220839dee0a9da259c115859d0b1e2a52f))
* **login,mcp:** unblock end-to-end auth + ugeplan, sharpen MCP UX ([f711ca4](https://github.com/Casperjuel/aula-mcp/commit/f711ca4b48ff495459c15f8b2b8dda838880e01e))

## [1.2.1](https://github.com/Casperjuel/aula-mcp/compare/v1.2.0...v1.2.1) (2026-06-09)


### Bug Fixes

* **auth,meebook:** support MitID hardware kodeviser + fix dup identities & Meebook unilogin ([#42](https://github.com/Casperjuel/aula-mcp/issues/42)) ([1c37582](https://github.com/Casperjuel/aula-mcp/commit/1c3758220839dee0a9da259c115859d0b1e2a52f))

## [1.2.0](https://github.com/Casperjuel/aula-mcp/compare/v1.1.0...v1.2.0) (2026-05-22)


### Features

* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))

## [1.1.0](https://github.com/Casperjuel/aula-mcp/compare/v1.0.0...v1.1.0) (2026-05-22)


### Features

* **presence:** komme/gå template read + write tools ([#31](https://github.com/Casperjuel/aula-mcp/issues/31)) ([3a7c3da](https://github.com/Casperjuel/aula-mcp/commit/3a7c3da531d29aa55d62d6919088da848bdf7da7))

## 1.0.0 (2026-05-13)


### Features

* **aula-auth:** foundation utilities (HTTP, crypto, cookies, HTML, PKCE) ([b2678e1](https://github.com/Casperjuel/aula-mcp/commit/b2678e14d38c82cf557139d0ceeb06a8c8750b73))
* **aula-client:** API version probing + core endpoints + widget token manager ([d8c7c9f](https://github.com/Casperjuel/aula-mcp/commit/d8c7c9f76c2808daddfc4526973d72a11db8edd6))
* **aula-client:** integration plugins (EasyIQ, Meebook, Min Uddannelse, Systematic) ([26a6798](https://github.com/Casperjuel/aula-mcp/commit/26a6798a641fb15784bd29c385c6eab7f00d5594))
* **integrations:** add EasyIQ Lektier widget (0142) ([#8](https://github.com/Casperjuel/aula-mcp/issues/8)) ([106f4c8](https://github.com/Casperjuel/aula-mcp/commit/106f4c80da1eea050ce89f135876209481d0e366))
* **integrations:** EasyIQ SkolePortal (widget 0128, PR scaarup/aula[#352](https://github.com/Casperjuel/aula-mcp/issues/352)) ([e754f1b](https://github.com/Casperjuel/aula-mcp/commit/e754f1b954dd1e7c9aaec4c66cc4b38ce7795c21))
* **mcp:** widget detection, friendly calendar range, raw escape hatch, notifications + posts tools ([1ec1a5f](https://github.com/Casperjuel/aula-mcp/commit/1ec1a5f4aa3bddeec8187a054df7a7b56f62b2fd))


### Bug Fixes

* **login,mcp:** unblock end-to-end auth + ugeplan, sharpen MCP UX ([f711ca4](https://github.com/Casperjuel/aula-mcp/commit/f711ca4b48ff495459c15f8b2b8dda838880e01e))
