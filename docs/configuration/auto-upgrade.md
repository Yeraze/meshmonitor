# Automatic Self-Upgrade (Retired)

::: warning Retired in v4.13
The Automatic Self-Upgrade feature described on this page — the watchdog
sidecar, one-click "Upgrade Now" button, and unattended auto-apply setting —
has been **removed** as of MeshMonitor v4.13. This page is kept so old links
and bookmarks don't 404.
:::

## Why it was removed

The watchdog sidecar coordinated with the main container through shared
trigger/status files with no locking or handshake, and had to
reverse-engineer each user's Docker setup (Compose paths, project labels,
Portainer/Synology/Unraid stacks) to recreate the container correctly — over
half its commit history was bug fixes for exactly that class of problem. It
also required mounting the Docker socket (root-equivalent host access) for a
convenience feature, and never worked at all outside Docker Compose (no LXC,
Kubernetes, bare metal, or Windows/Mac support).

MeshMonitor now takes the same posture as other mature self-hosted apps
(Home Assistant, Grafana, Gitea): it **detects and notifies**, and leaves the
actual upgrade to tools built for the job.

## What to do instead

See **[Updating MeshMonitor](/configuration/updating)** for:

- How the update-available banner and `upgrade-available` automation event
  work now.
- Per-platform update instructions (Docker Compose, LXC, Kubernetes/Helm,
  bare metal).
- An unattended-updates recipe using [Watchtower](/configuration/updating#unattended-updates-with-watchtower).
- A migration checklist if you were running the old sidecar.

For the full rationale, read the
[retirement announcement on the blog](/blog/2026-07-13-retiring-auto-upgrade).
