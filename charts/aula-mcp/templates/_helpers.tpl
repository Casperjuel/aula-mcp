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

{{/* The ui Deployment's own name label, so the MCP Service never selects it. */}}
{{- define "aula-mcp.uiSelectorLabels" -}}
app.kubernetes.io/name: {{ include "aula-mcp.name" . }}-ui
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "aula-mcp.uiName" -}}
{{- printf "%s-ui" (include "aula-mcp.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Secret with the key the API knows the ui server by. */}}
{{- define "aula-mcp.uiKeySecret" -}}
{{- printf "%s-ui-key" (include "aula-mcp.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "aula-mcp.mcpUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v/mcp" (include "aula-mcp.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}

{{/* Refuse combinations that would expose a parent's Aula session. */}}
{{- define "aula-mcp.validate" -}}
{{- if and .Values.telemetry.enabled (not .Values.telemetry.endpoint) }}{{ fail "telemetry needs telemetry.endpoint (an OTLP/HTTP collector URL)" }}{{ end }}
{{- if and .Values.perses.enabled (not (and .Values.telemetry.enabled .Values.telemetry.signals.metrics)) }}{{ fail "perses needs telemetry.enabled and telemetry.signals.metrics: the dashboard reads those metrics" }}{{ end }}
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
{{- if not (has .Values.storage.type (list "sqlite" "postgres" "none")) }}
{{- fail "storage.type must be sqlite, postgres or none" }}
{{- end }}
{{- if and (eq .Values.storage.type "postgres") (not .Values.storage.postgres.existingSecret) }}
{{- fail "storage.type postgres needs storage.postgres.existingSecret with the database URL" }}
{{- end }}
{{- if and .Values.httpRoute.setupUi.enabled (not .Values.setupUi.enabled) }}
{{- fail "httpRoute.setupUi needs setupUi.enabled" }}
{{- end }}
{{- if and .Values.api.enabled (not (include "aula-mcp.multiParent" .)) }}{{ fail "api needs mode: multi-parent; every call is checked against oidc.issuer" }}{{ end }}
{{- if and .Values.ui.enabled (not .Values.api.enabled) }}{{ fail "ui needs api.enabled: the dashboard reads and changes everything through the API" }}{{ end }}
{{- if .Values.ui.enabled }}
{{- if not .Values.ui.url }}{{ fail "ui needs ui.url: the origin browsers open it on" }}{{ end }}
{{- if not .Values.ui.clientId }}{{ fail "ui needs ui.clientId" }}{{ end }}
{{- if .Values.setupUi.enabled }}{{ fail "ui and setupUi are two dashboards for the same parents; enable one" }}{{ end }}
{{- end }}
{{- if and .Values.api.enabled (eq (int .Values.api.port) 7878) }}{{ fail "api.port must differ from the MCP port 7878" }}{{ end }}
{{- if and .Values.httpRoute.api.enabled (not .Values.api.enabled) }}{{ fail "httpRoute.api needs api.enabled" }}{{ end }}
{{- if and .Values.httpRoute.ui.enabled (not .Values.ui.enabled) }}{{ fail "httpRoute.ui needs ui.enabled" }}{{ end }}
{{- end }}

{{/* service.name for telemetry and the dashboard. */}}
{{- define "aula-mcp.serviceName" -}}
{{- .Values.telemetry.serviceName | default (include "aula-mcp.fullname" .) }}
{{- end }}

{{- define "aula-mcp.telemetrySignals" -}}
{{- $on := list }}
{{- range $name := list "traces" "metrics" "logs" }}
{{- if index $.Values.telemetry.signals $name }}{{ $on = append $on $name }}{{ end }}
{{- end }}
{{- join "," $on }}
{{- end }}

{{- define "aula-mcp.resourceAttributes" -}}
{{- $pairs := list }}
{{- range $k, $v := .Values.telemetry.resourceAttributes }}
{{- $pairs = append $pairs (printf "%s=%v" $k $v) }}
{{- end }}
{{- join "," $pairs }}
{{- end }}

{{/* OpenTelemetry env, the same for the MCP pod and the ui server. */}}
{{- define "aula-mcp.telemetryEnv" -}}
{{- if .Values.telemetry.enabled -}}
- name: AULA_MCP_OTEL
  value: "1"
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.telemetry.endpoint | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ include "aula-mcp.serviceName" . | quote }}
- name: AULA_MCP_OTEL_SIGNALS
  value: {{ include "aula-mcp.telemetrySignals" . | quote }}
- name: AULA_MCP_OTEL_SAMPLE_RATIO
  value: {{ .Values.telemetry.traceSampleRatio | quote }}
- name: OTEL_METRIC_EXPORT_INTERVAL
  value: {{ mul .Values.telemetry.metricIntervalSeconds 1000 | quote }}
{{- with .Values.telemetry.resourceAttributes }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ include "aula-mcp.resourceAttributes" $ | quote }}
{{- end }}
{{- end }}
{{- end }}
