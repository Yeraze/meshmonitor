---
layout: doc
---

# API Reference

<script setup>
import SwaggerUI from '../.vitepress/components/SwaggerUI.vue'
</script>

Interactive API documentation powered by Swagger UI. You can explore all available endpoints, view request/response examples, and even test API calls directly from this page.

## Authentication

Most API endpoints require authentication using an API token. See the [API Authentication](/development/api-auth.html) guide for details on generating and using API tokens.

## Interactive Documentation

<ClientOnly>
  <SwaggerUI />
</ClientOnly>

::: tip
The interactive documentation above is the same as what's available on your running MeshMonitor instance at `/api/v1/docs`. You can test API calls directly from this page, but you'll need to provide a valid API token using the "Authorize" button.
:::
