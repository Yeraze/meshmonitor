---
id: news-2026-07-13-retiring-auto-upgrade
title: Retiring Auto-Upgrade in 4.13
date: '2026-07-13T18:00:00Z'
category: maintenance
priority: important
minVersion: 4.13.0
---
MeshMonitor 4.13 removes the Automatic Self-Upgrade feature — the watchdog
sidecar, the one-click "Upgrade Now" button, and unattended auto-apply. This
was not an easy call, and if you relied on it, we want to explain exactly
why, and what replaces it.

## Why we're removing it

Auto-upgrade only ever worked one way: a sidecar container watching for a
trigger file, pulling a new image, and recreating the MeshMonitor container
by reverse-engineering whatever Docker setup you happened to have. In
practice, "whatever Docker setup you happened to have" turned out to be a
much bigger surface than one feature could reasonably cover — plain Compose,
Portainer stacks, Synology's Container Manager, Unraid, `.env` interpolation
quirks, project labels that didn't match what we expected. Every one of
those was a different way for the sidecar to reconstruct your container
wrong.

The numbers back this up: more than half of the commits touching the
upgrade service and watchdog script over its lifetime were bug fixes for
exactly this class of problem — races between the backend and sidecar
communicating through shared files with no locking or handshake, a circuit
breaker that existed only to recover from those races, stale-state reapers,
boot-time reconciliation. It was a distributed system built on the
shakiest possible coordination primitive, and it showed.

On top of that, the sidecar needed the Docker socket mounted into it — root-
equivalent access to your host — for a convenience feature. And it only ever
worked for Docker Compose. If you ran MeshMonitor on Proxmox LXC,
Kubernetes, bare metal, or Windows/Mac, you saw the auto-upgrade UI and got
an error, every time, forever.

Mature self-hosted projects — Home Assistant, Grafana, Gitea — don't try to
replace their own container from the inside. They tell you an update
exists and get out of the way. We're adopting the same posture.

## What stays

We didn't rip out update *detection* — just execution. As of 4.13,
MeshMonitor still:

- **Checks for new releases** on a schedule, server-side, with no browser
  required.
- **Shows an "Update available" banner** with copy-pasteable, per-platform
  instructions — Docker, LXC, Kubernetes, bare metal.
- **Fires the `upgrade-available` automation event** — this already existed,
  but it now fires headlessly instead of only when a browser happened to hit
  the version-check endpoint. Wire it to a webhook, ntfy, Discord, or email
  notification in the [Automation Engine](/features/automation-engine) and
  you'll hear about new releases the moment they ship, whether or not
  MeshMonitor's UI is open anywhere.

You can still turn all of this off with `VERSION_CHECK_DISABLED=true` for
air-gapped or otherwise externally-managed deployments, same as before.

## What to do instead

**Docker Compose:**

```bash
docker compose pull
docker compose up -d
```

If you want that to happen automatically, add
[Watchtower](https://github.com/nicholas-fedor/watchtower) — a dedicated,
actively maintained tool that does exactly this job, scoped to just your
MeshMonitor container:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    restart: unless-stopped
    labels:
      - com.centurylinklabs.watchtower.enable=true
    # ...your existing meshmonitor config...

  watchtower:
    image: nickfedor/watchtower:1.14.2
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_LABEL_ENABLE=true
      - WATCHTOWER_POLL_INTERVAL=86400
      - WATCHTOWER_CLEANUP=true
```

The [Docker Compose Configurator](/configurator) can generate this for you —
flip the **Watchtower (unattended updates)** toggle. Worth saying plainly:
Watchtower still needs the Docker socket, same trade-off the old sidecar
had. The difference is Watchtower is a focused, widely-used tool maintained
by people whose whole job is getting container recreation right across every
Docker flavor — not a bespoke script bundled into MeshMonitor trying to
reinvent that wheel.

**Proxmox LXC:** unchanged — `meshmonitor-update` inside the container still
does an in-place git pull, rebuild, and restart.

**Kubernetes/Helm:** bump the image tag and `helm upgrade`, or hand it to
[Renovate](https://docs.renovatebot.com/) or [Flux](https://fluxcd.io/)
image automation if you want it hands-off.

**Bare metal:** `git pull && npm install --legacy-peer-deps && npm run
build && npm run build:server`, then restart the service.

Full details for every platform: [Updating MeshMonitor](/configuration/updating).

## Migration checklist

If you're running the old sidecar today:

1. Drop `-f docker-compose.upgrade.yml` from your `docker compose` command.
2. `docker rm -f meshmonitor-upgrader` to remove the orphaned sidecar
   container (MeshMonitor never had socket access, so it can't do this for
   you).
3. Remove `AUTO_UPGRADE_ENABLED` from your environment — it no longer does
   anything.
4. Nothing else to do — stale `/data/.upgrade-*` files and the internal
   watchdog scripts are cleaned up automatically the first time your
   container boots on 4.13.

The full walkthrough, with commands, is in the
[migration section](/configuration/updating#migrating-from-the-old-auto-upgrade-sidecar)
of the updated docs.

## Thanks

If you were one of the people running the sidecar and it just worked for
you — thank you for trusting us with root on your Docker host, and sorry for
the churn. This isn't a feature we're walking away from lightly; it's one we
watched fail in enough different environments to conclude that a dedicated
tool, doing one job well, serves you better than we ever could bundling it
in ourselves.
