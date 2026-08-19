---
name: Meshtastic firmware branch layout and how to fetch sources in this env
description: firmware `develop` is the 2.8 line and `master` is 2.7 — unreleased features are only on develop; plus which fetch methods work through this sandbox's proxy
type: reference
---

## Branch layout (meshtastic/firmware)

- `master` — current stable line. As of 2026-08 this is the 2.7.x tree.
- `develop` — the 2.8.0 development line (`version.properties` reads major=2 minor=8 build=0).
  **New/unreleased modules land here first and are absent from `master`.**

A "file not found on master" result does NOT mean a feature does not exist. Always probe
`develop` before concluding a module is unimplemented. Example: the MeshBeacon module
(`src/modules/MeshBeaconModule.{cpp,h}`) 404s on `master` but is present on `develop`.

There are no `2.8`, `2.7`, or `next` branches — probing those returns 404.

## What works for fetching, in this sandbox

- `https://raw.githubusercontent.com/meshtastic/firmware/<branch>/<path>` via `curl` — **works**.
  This is the primary tool. Probing candidate paths with `-o /dev/null -w "%{http_code}"` is
  the fastest way to locate a file.
- `https://api.github.com/...` for repos other than the session's own — **403**, the session is
  bound to its configured repositories. The github MCP tools are subject to the same scoping.
- `https://github.com/...` HTML via `curl` — **403** through the proxy.
- The `WebFetch` tool on `github.com` URLs — **works**, and is the way to list a directory's
  contents or search PRs. Note it summarizes via a small model, so treat a WebFetch directory
  listing as a hint, not proof; confirm individual files with a raw.githubusercontent probe.

## Local protobufs

This repo vendors `meshtastic/protobufs` as a real submodule at `protobufs/` (genuine upstream
remote). Read `.proto` and `.options` files from there rather than fetching, but check
`git -C protobufs log` — the pin may lag upstream master.
