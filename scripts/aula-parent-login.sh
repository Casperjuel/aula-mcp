#!/bin/sh
# Log one parent into Aula with MitID, into that parent's own token directory.
#
#   kubectl -n <namespace> exec -it deploy/<release> -- aula-parent-login <sub>
#
# <sub> is the parent's user ID in the identity provider (in Keycloak: Users,
# then the user, then "ID"). The directory is derived the same way the server
# derives it (packages/mcp-server/src/oidc.ts callerId), so the login lands
# where that parent's requests will look for it.
set -eu

sub=${1:?usage: aula-parent-login <IdP user id (sub)>}
: "${AULA_MCP_OIDC_ISSUER:?AULA_MCP_OIDC_ISSUER is not set}"

id=$(printf '%s\n%s' "$AULA_MCP_OIDC_ISSUER" "$sub" | sha256sum | cut -c1-32)
dir="${AULA_MCP_DIR:-/data}/parents/$id"
mkdir -p "$dir"
chmod 700 "$dir"

echo "Aula login for $sub into $dir"
cd /app
AULA_MCP_NO_KEYCHAIN=1 AULA_MCP_DIR="$dir" exec bun apps/cli/src/index.ts login
