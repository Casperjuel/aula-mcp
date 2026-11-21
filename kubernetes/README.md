# aula-mcp on Kubernetes, behind kagent

Runs aula-mcp in **multi-parent mode** for [kagent](https://kagent.dev): every
parent signs in to kagent through Keycloak, kagent forwards that parent's token
to aula-mcp, and aula-mcp answers with **that parent's own Aula login** only.
A parent without an Aula login gets "No tokens on disk", never someone else's.

```
browser ── oauth2-proxy ── kagent UI ── agent ──(parent's ID token)──▶ aula-mcp
             │                                                        │
             └──── Keycloak realm "kagent" ◀── verifies signature ────┘
                                                aud must include aula-mcp
```

| Path | What |
| --- | --- |
| `Dockerfile` | Image built from the repository root (the checked-out code). |
| `parent-login.sh` | `aula-parent-login <sub>`: MitID login for one parent, inside the pod. |
| `kustomization.yaml`, `*.yaml` | Namespace `aula-mcp`, PVC, Deployment, Service, NetworkPolicy. |
| `config.env` | Server settings, turned into a ConfigMap. |
| `kagent/` | `RemoteMCPServer`, an example `Agent`, and Helm values for kagent SSO. |
| `keycloak/kagent-client.json` | Keycloak client for kagent, with the `aula-mcp` audience. |

Replace `keycloak.example.com`, `kagent.example.com` and
`registry.example.com` with your own hosts throughout.

## 1. Keycloak

In the realm `kagent`:

1. **Clients → Import client**, pick `keycloak/kagent-client.json`, save. On
   **Credentials**, copy the client secret.
2. **Users**: add one user per parent. Set an email and tick **Email
   verified** (oauth2-proxy refuses unverified emails), then set a password.
3. Note each parent's **ID** (the `sub`); you need it for the Aula login.

The client's audience mapper puts `aula-mcp` in the **ID token**. That matters:
oauth2-proxy forwards the ID token, not the access token, so aula-mcp runs with
`AULA_MCP_OIDC_ACCEPT_ID_TOKEN=1` and still requires `aud` to contain
`aula-mcp`. Tokens from any other client in the realm are refused.

## 2. kagent SSO

kagent needs a signed-in user before it has a token to pass on. This turns on
the chart's oauth2-proxy and makes kagent trust its headers. **It changes the
kagent login for everyone**: the UI then requires a Keycloak sign-in.

```sh
kubectl -n kagent create secret generic kagent-oidc \
  --from-literal=client-id=kagent \
  --from-literal=client-secret='<secret from step 1>' \
  --from-literal=cookie-secret="$(openssl rand -base64 32 | tr -- '+/' '-_')"
```

Merge `kagent/oauth2-proxy-values.yaml` into the kagent Helm release, then point
the public route at oauth2-proxy instead of the UI:

```yaml
# HTTPRoute for kagent: backendRefs
- name: kagent-oauth2-proxy
  port: 4180
```

## 3. Image

```sh
podman build --platform linux/amd64 -f kubernetes/Dockerfile \
  -t registry.example.com/aula-mcp:<tag> .
podman push registry.example.com/aula-mcp:<tag>
```

Set `images[0].newName`/`newTag` in `kustomization.yaml` to match.

## 4. Deploy

Set `AULA_MCP_OIDC_ISSUER` in `config.env` to the realm, e.g.
`https://keycloak.example.com/realms/kagent`, then:

```sh
kubectl apply -k kubernetes
kubectl apply -k kubernetes/kagent
```

The `RemoteMCPServer` carries `kagent.dev/discovery: disabled`: aula-mcp refuses
the controller's token-less tool listing, so agents list the tools at run time
with the parent's token. Its status shows no discovered tools; that is expected.

## 5. Log each parent into Aula

Once per parent, with their Keycloak `sub`:

```sh
kubectl -n aula-mcp exec -it deploy/aula-mcp -- aula-parent-login <sub>
```

The QR code for the MitID app prints in the terminal. The tokens go to
`/data/parents/<id>/`, where `<id>` is derived from the issuer and `sub` the same
way the server derives it. No restart needed.

## Notes

- **One replica.** MCP sessions and the token store live in the pod;
  `Recreate` keeps two pods off the same volume.
- **NetworkPolicy** lets only the `kagent` namespace reach port 7878. A
  parent's token is forwarded to every MCP server their agent uses, so keep
  that list short.
- **Token lifetime.** Keycloak ID tokens last 5 minutes by default;
  `cookie-refresh: 4m` renews them before they expire mid-chat.
- The volume holds every parent's Aula refresh token, each encrypted with a
  key stored beside it. Treat the volume and its backups as secret.
