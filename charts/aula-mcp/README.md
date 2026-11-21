# aula-mcp Helm chart

Runs aula-mcp on Kubernetes, alone or as a tool server for
[kagent](https://kagent.dev).

| `mode` | Who can use it | Use for |
| --- | --- | --- |
| `single-parent` (default) | Anyone who reaches `/mcp` acts as the one logged-in parent. | One family, reached only from inside the cluster. |
| `multi-parent` | Every request needs a token from `oidc.issuer`. Each parent uses only their own Aula login. | Several parents behind an IdP, e.g. kagent with Keycloak. |

The chart refuses setups that would expose a parent's Aula session:

- `httpRoute.mcp` without `multi-parent` mode;
- `setupUi` in `multi-parent` mode, or without `setupUi.iUnderstandItHasNoAuth`;
- `oidc.acceptIdToken` without `multi-parent` mode.

## Image

No image is published yet. Build one from the repository root:

```sh
podman build --platform linux/amd64 -t registry.example.com/aula-mcp:dev .
podman push registry.example.com/aula-mcp:dev
```

## Install

```sh
helm upgrade --install aula-mcp charts/aula-mcp -n aula-mcp --create-namespace \
  --set image.repository=registry.example.com/aula-mcp --set image.tag=dev
```

Then log the parent in (the MitID QR code prints in the terminal):

```sh
kubectl -n aula-mcp exec -it deploy/aula-mcp -- bun apps/cli/src/index.ts login
```

## Values

| Value | Default | What |
| --- | --- | --- |
| `mode` | `single-parent` | `single-parent` or `multi-parent`. |
| `oidc.issuer` / `oidc.audience` | `""` / `aula-mcp` | Token issuer and required `aud`, multi-parent only. |
| `oidc.acceptIdToken` | `false` | Also accept Keycloak ID tokens (needed with kagent). |
| `writeTools` | `false` | Enable write tools (`AULA_MCP_WRITE=1`). |
| `encryptionKey.existingSecret` | `""` | Secret with `AULA_MCP_KEY` for the token store. |
| `persistence.*` | 1Gi PVC | Token store. Kept on uninstall. |
| `setupUi.enabled` | `false` | Browser login UI on port 8099. **No authentication.** |
| `httpRoute.mcp` / `httpRoute.setupUi` | off | Gateway API routes; need `parentRefs`. |
| `networkPolicy.enabled` / `.from` | on / `[]` | Allowed peers. kagent's namespace is added when `kagent.enabled`. |
| `kagent.enabled` | `false` | Create a `RemoteMCPServer` in `kagent.namespace`. |
| `kagent.agent.enabled` | `false` | Also create an example `Agent` that uses it. |

With `networkPolicy` on, add your Gateway's namespace to `networkPolicy.from`
when you enable an HTTPRoute.

## kagent with Keycloak (multi-parent)

```
browser ── oauth2-proxy ── kagent UI ── agent ──(parent's ID token)──▶ aula-mcp
             │                                                        │
             └──────────── Keycloak realm ◀── verifies signature ─────┘
                                               aud must include aula-mcp
```

1. **Keycloak**, in your realm:
   - **Clients → Import client** with `examples/keycloak-kagent-client.json`.
     Set the redirect URI to your kagent host and copy the client secret.
   - Add one user per parent, with an email and **Email verified** ticked
     (oauth2-proxy refuses unverified emails).
   - Note each parent's **ID**, which is the `sub` in their token.

   The client's audience mapper adds `aula-mcp` to the **ID token**.
   oauth2-proxy forwards the ID token, so aula-mcp needs
   `oidc.acceptIdToken: true`, and it still requires `aud` to contain
   `aula-mcp`. Tokens from other clients in the realm are refused.

2. **kagent sign-in.** kagent needs a signed-in user before it has a token
   to pass on. **This changes the kagent login for everyone**: the UI then
   requires a Keycloak sign-in.

   ```sh
   kubectl -n kagent create secret generic kagent-oidc \
     --from-literal=client-id=kagent \
     --from-literal=client-secret='<client secret>' \
     --from-literal=cookie-secret="$(openssl rand -base64 32 | tr -- '+/' '-_')"
   ```

   Merge `examples/kagent-sso-values.yaml` into the kagent Helm release. Point
   kagent's public route at `kagent-oauth2-proxy:4180` instead of the UI.

3. **aula-mcp**:

   ```yaml
   mode: multi-parent
   oidc:
     issuer: https://keycloak.example.com/realms/kagent
     acceptIdToken: true
   kagent:
     enabled: true
     agent:
       enabled: true
   ```

4. **Log each parent into Aula**, once, with their Keycloak `sub`:

   ```sh
   kubectl -n aula-mcp exec -it deploy/aula-mcp -- aula-parent-login <sub>
   ```

   The login is stored under `/data/parents/<id>/`. The `<id>` comes from the
   issuer and `sub`, the same way the server derives it. No restart needed.
   A parent who hasn't logged in gets "No tokens on disk", never someone
   else's data.

The `RemoteMCPServer` gets the label `kagent.dev/discovery: disabled`, because
aula-mcp refuses the controller's tool listing, which carries no token. Agents
list the tools at run time with the parent's token instead. So its status
shows no discovered tools; that is expected.

## Local test with kind

```sh
scripts/kind-test.sh          # builds the image, installs both modes, runs helm test
scripts/kind-test.sh delete   # removes the cluster
```

It checks:

- `/healthz` answers;
- multi-parent mode refuses `/mcp` without a token (401);
- the `RemoteMCPServer` has token passthrough on and discovery off;
- the NetworkPolicy blocks a pod that isn't allowed.

It installs only the kagent CRDs, not kagent or Keycloak.

## Notes

- **One replica.** MCP sessions and the token store live in the pod;
  `Recreate` keeps two pods off the same volume.
- **Token lifetime.** Keycloak ID tokens last 5 minutes by default.
  `cookie-refresh: 4m` in the kagent values renews them before they expire.
- **The volume is secret.** It holds every parent's Aula refresh token, each
  encrypted with a key stored beside it. Treat the volume and its backups as
  secret, or set `encryptionKey.existingSecret` so the key lives elsewhere.
