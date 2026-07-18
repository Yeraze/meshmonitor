---
layout: doc
---

# API Reference

MeshMonitor exposes a REST API for interacting with your mesh network programmatically. The interactive Swagger UI below is the canonical reference.

## Quick start

1. Start MeshMonitor (locally or access your deployment).
2. Open **Settings → API Tokens** and generate a token.
3. Click **Authorize** in the Swagger UI below and paste the token.
4. Expand any endpoint and click **Try it out** to make live calls against your instance.

::: tip Same docs, two places
The Swagger UI rendered below is identical to the one served by your running MeshMonitor at `/api/v1/docs`. Use either — they read from the same OpenAPI spec.
:::

## Versioning

All endpoints are prefixed with `/api/v1/`. When endpoint shapes change within v1, the old shape is kept working for at least one release with a deprecation `Warning` header before removal; larger overhauls would ship as `/api/v2/`.

**4.13 shape change (root paths removed in 4.14):** mesh-data resources (nodes, messages, channels, telemetry, traceroutes, network, packets, status, position-history) are served under `/api/v1/sources/{sourceId}/...`. The old root-scoped v1 paths (`/api/v1/nodes?sourceId=...` etc.) were deprecated in 4.13 with a one-release `Warning: 299` grace period and removed in 4.14 — they now return `404`. Use `"default"` as `{sourceId}` to target the primary source. See the [v1 source-scoping announcement](/blog/2026-07-13-v1-api-source-scoping) for the full migration guide, or [REST_API.md](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/REST_API.md) in the repository for the endpoint-by-endpoint table.

## Interactive documentation

<script setup>
import SwaggerUI from '../.vitepress/components/SwaggerUI.vue'
</script>

<ClientOnly>
  <SwaggerUI />
</ClientOnly>
