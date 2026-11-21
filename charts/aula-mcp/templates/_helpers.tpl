{{- define "aula-mcp.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "aula-mcp.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "aula-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aula-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "aula-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "aula-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Pods with this label may reach the server despite the NetworkPolicy (helm test). */}}
{{- define "aula-mcp.clientLabel" -}}
{{ include "aula-mcp.fullname" . }}-client: "true"
{{- end }}

{{- define "aula-mcp.multiParent" -}}
{{- if eq .Values.mode "multi-parent" }}true{{ end }}
{{- end }}

{{- define "aula-mcp.mcpUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v/mcp" (include "aula-mcp.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}

{{/* Refuse combinations that would expose a parent's Aula session. */}}
{{- define "aula-mcp.validate" -}}
{{- if not (has .Values.mode (list "single-parent" "multi-parent")) }}
{{- fail "mode must be single-parent or multi-parent" }}
{{- end }}
{{- if include "aula-mcp.multiParent" . }}
{{- if not .Values.oidc.issuer }}{{ fail "multi-parent mode needs oidc.issuer" }}{{ end }}
{{- if not .Values.oidc.audience }}{{ fail "multi-parent mode needs oidc.audience" }}{{ end }}
{{- if .Values.setupUi.enabled }}
{{- if not .Values.setupUi.login.url }}{{ fail "setupUi in multi-parent mode needs setupUi.login.url: it signs each parent in first" }}{{ end }}
{{- if not .Values.setupUi.login.clientId }}{{ fail "setupUi in multi-parent mode needs setupUi.login.clientId" }}{{ end }}
{{- end }}
{{- else }}
{{- if .Values.oidc.acceptIdToken }}{{ fail "oidc.acceptIdToken needs mode: multi-parent" }}{{ end }}
{{- if .Values.httpRoute.mcp.enabled }}
{{- fail "httpRoute.mcp needs mode: multi-parent; in single-parent mode anyone who reaches /mcp acts as the parent" }}
{{- end }}
{{- if and .Values.setupUi.enabled (not .Values.setupUi.iUnderstandItHasNoAuth) }}
{{- fail "setupUi has no authentication in single-parent mode; set setupUi.iUnderstandItHasNoAuth=true to enable it" }}
{{- end }}
{{- if or .Values.setupUi.login.url .Values.setupUi.login.clientSecret.existingSecret }}
{{- fail "setupUi.login needs mode: multi-parent" }}
{{- end }}
{{- end }}
{{- if and .Values.httpRoute.setupUi.enabled (not .Values.setupUi.enabled) }}
{{- fail "httpRoute.setupUi needs setupUi.enabled" }}
{{- end }}
{{- end }}
