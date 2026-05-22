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

All endpoints are prefixed with `/api/v1/`. Breaking changes will ship as `/api/v2/` and keep `/api/v1/` working for at least one major release.

## Interactive documentation

<script setup>
import SwaggerUI from '../.vitepress/components/SwaggerUI.vue'
</script>

<ClientOnly>
  <SwaggerUI />
</ClientOnly>
