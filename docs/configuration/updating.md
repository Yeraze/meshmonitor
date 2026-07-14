# Updating MeshMonitor

::: tip What happened to Auto-Upgrade?
As of **v4.13**, MeshMonitor no longer performs upgrades itself — the watchdog
sidecar and unattended auto-apply feature have been retired. MeshMonitor still
**detects** new releases and tells you exactly how to update for your
deployment. See the [retirement announcement](/blog/2026-07-13-retiring-auto-upgrade)
for the full story, or jump to [migrating from the old sidecar](#migrating-from-the-old-auto-upgrade-sidecar)
below.
:::

MeshMonitor checks GitHub for new releases on a schedule and surfaces what it
finds — it never modifies its own container, files, or database on your
behalf. How you apply an update depends on how you deployed MeshMonitor;
pick your platform below.

## How update notifications work

When a newer version is available, MeshMonitor shows an **"Update available"**
banner in the UI with copy-pasteable instructions for your detected
deployment method (Docker, LXC, Kubernetes, or bare metal), plus a link to
the GitHub release notes. The banner is dismissible per-version.

Under the hood, the same check also fires an `upgrade-available` **system
event** into the [Automation Engine](/features/automation-engine) — headlessly,
with no browser required. Wire it to a webhook, ntfy, Discord, Slack, or
email notification so you find out the moment a release ships, without
staring at the UI:

1. Go to **Automations** and create a new automation.
2. **WHEN** → trigger type **System Event** → event **`upgrade-available`**.
3. **RULE** → skip the condition (leave it unconditional) or add one if you
   only want to be notified above a certain priority.
4. **THEN** → action **Apprise Notification** (or **Run Script** / **Send
   Message**, if you'd rather post somewhere custom) with a message like:

   ```text
   MeshMonitor {{ trigger.currentVersion }} → {{ trigger.latestVersion }} is available.
   {{ trigger.releaseUrl }}
   ```

See the [Automation Engine guide](/features/automation-engine) for the full
trigger/condition/action reference.

### Disabling update checks

Air-gapped deployments, or anyone who manages updates entirely through
external tooling (CI/CD, Renovate, Kubernetes operators), can turn off the
check entirely:

```yaml
services:
  meshmonitor:
    environment:
      - VERSION_CHECK_DISABLED=true
```

This disables both the GitHub polling and the update banner. The
`upgrade-available` automation event never fires either, since there's
nothing to detect.

## Docker Compose

Pull the new image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

That's it — your `docker-compose.yml`, `.env`, and the `/data` volume are
untouched. MeshMonitor migrates its own database schema on startup.

::: tip Your image tag picks your update cadence
The tag in your `image:` line decides how often there is anything to pull:
**`:latest`** follows stable releases (~weekly), **`:dev`** follows release
candidates (~daily), and an exact tag like `:4.13.0` never moves. This
applies to manual pulls and Watchtower alike — Watchtower updates whatever
tag the container runs. See the
[release-tracks FAQ entry](/faq#how-often-does-meshmonitor-release) for the
full comparison.
:::

### Unattended updates with Watchtower

If you want your MeshMonitor container to update itself automatically without
running `docker compose pull` by hand, point [Watchtower](https://github.com/nicholas-fedor/watchtower)
at it instead of building that logic into MeshMonitor. Watchtower is a
dedicated, actively maintained tool for exactly this job — it owns the
pull/recreate problem across the many different ways people run Docker
(plain Compose, Portainer, Synology, Unraid), which is more than MeshMonitor
could ever reliably do for itself.

::: warning containrrr/watchtower is archived
The original `containrrr/watchtower` image was archived in December 2025.
Use the community-maintained continuation, `nickfedor/watchtower` — same
environment variables, labels, volumes, and behavior, just a different image
name.
:::

Add a Watchtower service to your `docker-compose.yml`, **scoped to only the
`meshmonitor` container** with a label so it doesn't touch anything else on
your host:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    restart: unless-stopped
    labels:
      # Opt this container in to Watchtower's watch list
      - com.centurylinklabs.watchtower.enable=true
    # ...your existing meshmonitor config (ports, volumes, environment)...

  watchtower:
    image: nickfedor/watchtower:1.14.2
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      # Only touch containers explicitly labeled watchtower.enable=true
      - WATCHTOWER_LABEL_ENABLE=true
      # Check for new images once a day (seconds)
      - WATCHTOWER_POLL_INTERVAL=86400
      # Remove old images after a successful update
      - WATCHTOWER_CLEANUP=true
```

Then bring both services up:

```bash
docker compose up -d
```

Watchtower will notice new `ghcr.io/yeraze/meshmonitor` images matching your
existing tag (e.g. `latest`), pull them, and recreate the `meshmonitor`
container in place — preserving its ports, volumes, and environment, since
it clones the running container's own configuration rather than
re-interpreting your compose file.

**The trade-off, honestly:** Watchtower needs the same Docker socket mount
that the old sidecar did — that's root-equivalent access to your host's
Docker daemon. Label-scoping (`WATCHTOWER_LABEL_ENABLE=true` + the
`com.centurylinklabs.watchtower.enable=true` label) limits *what* it acts on,
not *what it could theoretically access*. If that trade-off isn't right for
your environment, `docker compose pull && docker compose up -d` on a schedule
(cron, a CI job, or just by hand when the banner shows up) is just as valid.

The [Docker Compose Configurator](/configurator) can generate this Watchtower
block for you — enable the **Watchtower (unattended updates)** toggle under
Additional Settings.

## LXC / Proxmox

LXC installs ship with `meshmonitor-update`, an in-place git-based updater
baked into the template. Run it inside the container:

```bash
meshmonitor-update
```

It pulls the latest code, rebuilds, and restarts the service for you. This
is unchanged by the Auto-Upgrade retirement — it was never part of that
subsystem.

## Kubernetes / Helm

Bump the image tag (or chart version, if you track the packaged chart) and
apply:

```bash
helm upgrade meshmonitor ./helm/meshmonitor \
  --set image.tag=4.13.0 \
  --reuse-values
```

Or, if you manage the Deployment directly:

```bash
kubectl set image deployment/meshmonitor meshmonitor=ghcr.io/yeraze/meshmonitor:4.13.0
kubectl rollout status deployment/meshmonitor
```

For hands-off updates, point a GitOps/update-automation tool at your
manifests or chart values instead of scripting it yourself:

- **[Renovate](https://docs.renovatebot.com/)** — opens a PR whenever a new
  MeshMonitor image tag is published; you review and merge.
- **[Flux](https://fluxcd.io/) image automation** — watches the registry and
  commits/updates the image tag directly, optionally gated by policy.

Both integrate with your existing PR/review/CD pipeline rather than
reaching into the cluster the way the old sidecar reached into Docker.

## Bare metal / from source

```bash
cd /var/lib/meshmonitor/meshmonitor

# Stop the service
sudo systemctl stop meshmonitor

# Pull latest changes
git pull
git submodule update --init --recursive

# Reinstall dependencies and rebuild
npm install --legacy-peer-deps
npm run build
npm run build:server

# Restart the service
sudo systemctl start meshmonitor
```

See the full [Deployment Guide](/deployment/DEPLOYMENT_GUIDE) for the
complete bare-metal install and update process.

## Migrating from the old Auto-Upgrade sidecar

If you previously ran the `docker-compose.upgrade.yml` overlay or set
`AUTO_UPGRADE_ENABLED=true`, clean up the leftover pieces:

1. **Stop using the upgrade overlay.** Drop `-f docker-compose.upgrade.yml`
   from however you start MeshMonitor:

   ```bash
   # Before
   docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d

   # After
   docker compose up -d
   ```

2. **Remove the orphaned watchdog container.** MeshMonitor never had Docker
   socket access itself, so it can't clean this up for you:

   ```bash
   docker rm -f meshmonitor-upgrader
   ```

3. **Remove `AUTO_UPGRADE_ENABLED` from your environment.** It no longer does
   anything as of v4.13 — delete the line from your `docker-compose.yml`
   environment block (or `.env` file) and redeploy.

4. **Stale internal files are cleaned up automatically.** On first v4.13
   boot, MeshMonitor removes leftover `/data/.upgrade-trigger`,
   `/data/.upgrade-status`, and the watchdog scripts it used to deploy to
   `/data/.meshmonitor-internal/`. No action needed on your part.

5. **Want unattended updates back?** Set up the
   [Watchtower recipe above](#unattended-updates-with-watchtower) — it's a
   drop-in replacement for what the sidecar used to do, minus the
   reconciliation bugs.

## Related Documentation

- [Automation Engine](/features/automation-engine) — build the
  `upgrade-available` notification recipe and anything else you want to
  automate.
- [Docker Compose Configurator](/configurator) — generate a `docker-compose.yml`
  with the Watchtower toggle enabled.
- [Production Deployment](/configuration/production) — general production
  hardening and operations guidance.
