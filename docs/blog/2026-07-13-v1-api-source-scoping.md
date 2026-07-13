---
id: news-2026-07-13-v1-api-source-scoping
title: 'MeshMonitor 4.13.0 — Breaking: the v1 API is now source-scoped'
date: '2026-07-13T17:00:00Z'
category: release
priority: important
minVersion: 4.13.0
---
Heads up if you drive MeshMonitor over its REST API. In 4.13.0 the v1 API becomes **source-scoped**: every endpoint that reads nodes, messages, telemetry, and friends now takes an explicit **Source ID** in the path. The old root paths (`/api/v1/nodes`, `/api/v1/messages`, …) that silently defaulted to "the primary source" still work for **one more release**, but they're deprecated and go away in 4.14.

## TL;DR — who's affected

- **Anyone calling the REST API** with an API token — scripts, cron jobs, Home Assistant/Node-RED flows, dashboards, anything hitting `/api/v1/...`.
- **The web UI is not affected.** It already talks to the internal, per-source endpoints. If you only use MeshMonitor in the browser, there is nothing to do.
- If your integration calls `/api/v1/nodes`, `/api/v1/messages`, `/api/v1/telemetry`, etc. **without** naming a source, it keeps working *today* on 4.13.0 (with a deprecation warning) and **breaks on 4.14** unless you migrate.

## Why this changed

MeshMonitor 4.x runs **N concurrent sources** — several Meshtastic TCP radios, MQTT bridges, and MeshCore nodes, all at once. The old v1 API predates that: with no source in the request, it quietly answered from "the primary" source.

In a single-radio deployment that was fine. In a multi-source deployment it's actively wrong — "the primary" is ambiguous, and a script that thinks it's reading your MQTT gateway's nodes could silently get a different radio's data. Rather than keep guessing, 4.13.0 makes the source explicit. No source, no guessing.

## The new shape

Per-source data lives under `/api/v1/sources/{sourceId}/...`:

```
/api/v1/sources/{sourceId}/nodes
/api/v1/sources/{sourceId}/messages
/api/v1/sources/{sourceId}/channels
/api/v1/sources/{sourceId}/telemetry
/api/v1/sources/{sourceId}/traceroutes
/api/v1/sources/{sourceId}/packets
/api/v1/sources/{sourceId}/network
/api/v1/sources/{sourceId}/status
/api/v1/sources/{sourceId}/nodes/{nodeId}/position-history
```

Discover the sources your token can read with:

```bash
curl -H "Authorization: Bearer mm_v1_..." \
  https://your-host/api/v1/sources
```

Each entry has an `id` you drop into the path. Don't want to look it up? The alias **`default`** resolves to the default source:

```bash
curl -H "Authorization: Bearer mm_v1_..." \
  https://your-host/api/v1/sources/default/nodes
```

**Deployment-global endpoints are unchanged** — they were never per-source and stay put:

```
/api/v1/solar
/api/v1/channel-database
```

## Migration guide

The change is mechanical: move the source out of the query string and into the path.

**Before (deprecated):**

```bash
curl -H "Authorization: Bearer mm_v1_..." \
  "https://your-host/api/v1/nodes?sourceId=meshtastic-1"

curl -H "Authorization: Bearer mm_v1_..." \
  "https://your-host/api/v1/messages?sourceId=meshtastic-1"
```

**After (canonical):**

```bash
curl -H "Authorization: Bearer mm_v1_..." \
  "https://your-host/api/v1/sources/meshtastic-1/nodes"

curl -H "Authorization: Bearer mm_v1_..." \
  "https://your-host/api/v1/sources/meshtastic-1/messages"
```

If you were relying on the old default-to-primary behavior and don't care which specific source ID you name, `default` is the drop-in replacement:

```bash
curl -H "Authorization: Bearer mm_v1_..." \
  "https://your-host/api/v1/sources/default/nodes"
```

### No more silent default

The strict per-source endpoints will **not** guess a source for you. Call one without a resolvable source and you get a clean 400 instead of wrong-source data:

```json
{
  "success": false,
  "error": "sourceId is required",
  "code": "MISSING_SOURCE_ID"
}
```

### MeshCore admin routes moved too

The MeshCore remote-admin routes are now source-scoped as well:

```
/api/meshcore/*   →   /api/sources/:id/meshcore/*
```

## The grace period, and how to spot stragglers

- **4.13.0 (now):** legacy root paths (`/api/v1/nodes?sourceId=...`) still work. Every legacy response carries a warning header:

  ```
  Warning: 299 - "v1 root-path scoping is deprecated; use /api/v1/sources/:sourceId/... instead"
  ```

  and the server logs one `[v1-deprecated]` line per legacy request.
- **4.14 (next release):** the legacy root paths are **removed**. Requests to them will 404.

To find integrations that still need migrating, watch for either signal:

- **Client side:** check for the `Warning: 299` header on your API responses. Curl shows it with `-i`:

  ```bash
  curl -i -H "Authorization: Bearer mm_v1_..." \
    "https://your-host/api/v1/nodes?sourceId=meshtastic-1" | grep -i '^warning:'
  ```

- **Server side:** grep your MeshMonitor logs for `[v1-deprecated]` (emitted at debug level) to see exactly which method/path/user is still on the old shape.

If neither shows up, you're already clean.

## Full reference

The complete, interactive endpoint list — with the source-scoped paths, request/response schemas, and a **Try it out** button against your own instance — is in the [API Reference](/development/api-reference). The same Swagger UI is served live by your deployment at `/api/v1/docs`.

Migrate your scripts before 4.14 and you'll never notice the cutover. Miss it and you'll get a 404 — but now you know where to look.
