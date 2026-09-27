{{/*
Expand the name of the chart.
*/}}
{{- define "meshmonitor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "meshmonitor.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "meshmonitor.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "meshmonitor.labels" -}}
helm.sh/chart: {{ include "meshmonitor.chart" . }}
{{ include "meshmonitor.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "meshmonitor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "meshmonitor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Type-dependent Service spec fields shared by the main Service and the optional
virtualNodeService (#5416). Pass the service values map as the context. Each
field renders only for the Service types Kubernetes accepts it on, so a value
left over from an earlier type never produces an invalid spec.
*/}}
{{- define "meshmonitor.serviceTypeFields" -}}
{{- $lb := eq (toString .type) "LoadBalancer" -}}
{{- $external := or $lb (eq (toString .type) "NodePort") -}}
{{- if and $lb .loadBalancerIP }}
loadBalancerIP: {{ .loadBalancerIP | quote }}
{{- end }}
{{- if and $lb .loadBalancerClass }}
loadBalancerClass: {{ .loadBalancerClass | quote }}
{{- end }}
{{- if and $lb .loadBalancerSourceRanges }}
loadBalancerSourceRanges:
{{- toYaml .loadBalancerSourceRanges | nindent 2 }}
{{- end }}
{{- if and $external .externalTrafficPolicy }}
externalTrafficPolicy: {{ .externalTrafficPolicy }}
{{- end }}
{{- end }}

{{/*
Container ports for the optional virtualNodeService that are not already
declared by service.extraPorts. Kubernetes rejects a pod spec with two
containerPort entries sharing a name, or a port+protocol pair, so a port
listed in both places renders once (#5416).
*/}}
{{- define "meshmonitor.virtualNodeContainerPorts" -}}
{{- if .Values.virtualNodeService.enabled }}
{{- $seenNames := dict "http" true -}}
{{- $seenPorts := dict (printf "%v/TCP" .Values.service.targetPort) true -}}
{{- range .Values.service.extraPorts }}
{{- $_ := set $seenNames (toString .name) true -}}
{{- $_ := set $seenPorts (printf "%v/%s" (.targetPort | default .port) (.protocol | default "TCP")) true -}}
{{- end }}
{{- range .Values.virtualNodeService.ports }}
{{- $key := printf "%v/%s" (.targetPort | default .port) (.protocol | default "TCP") -}}
{{- if not (or (hasKey $seenNames (toString .name)) (hasKey $seenPorts $key)) }}
{{- $_ := set $seenNames (toString .name) true -}}
{{- $_ := set $seenPorts $key true }}
- name: {{ .name }}
  containerPort: {{ .targetPort | default .port }}
  protocol: {{ .protocol | default "TCP" }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
