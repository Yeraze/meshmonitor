---
id: news-2026-10-12-docker-image-hardening
title: 'Security in v4.17.0: a hardened Docker image and stricter per-source permissions'
date: '2026-10-12T16:05:00Z'
category: security
priority: high
minVersion: 4.17.0
tags: [security, docker, kubernetes, helm, hardening, permissions]
---

A community member, DrivenMadz, ran a container scanner over the MeshMonitor image and sent us the result: 21 critical and 166 high findings. We went through them. Almost none could be reached in a running container, but the scan was still right about three things. **v4.17.0** fixes all three.

No known exploit is involved. This is hardening, not an incident.

The same release tightens permission checks and backup handling. That part is [further down](#permissions-and-backups), and it can change what your non-admin users see.

## What the scan found

1. **Build tools shipped in the runtime image.** The image copied the full `node_modules` tree, so `vite`, `vitest`, `typescript`, `eslint` and `puppeteer` rode along. The server never loads them, but a scanner counts every advisory in every package it finds.
2. **Two processes ran as root.** The web server already ran as the `node` user. `supervisord` and the bundled Apprise service did not.
3. **The base image was behind.** Most "critical" rows were in the Go standard library, inside binaries that come with the Node base image. MeshMonitor has no Go code.

## What changed

**Dev dependencies are gone.** The build now prunes them before the runtime image is assembled.

| | Before | After |
|---|---|---|
| `node_modules` | 763 MB | 369 MB |
| Image (amd64) | 1.44 GB | 964 MB |

CI now fails if a package the server can reach is not a declared runtime dependency, and fails if any dev dependency ships.

**Every long-running process runs as `node` (uid 1000).** The entrypoint still starts as root, does the few things that need root (fixing volume ownership, granting serial device groups), then drops to `node` before it starts `supervisord`. The server, Apprise and `supervisord` all run unprivileged. CI checks this on amd64, arm64 and armv7.

**Base images moved up**, with the same major versions: `node:24.21.0-alpine3.24` for amd64 and arm64, `node:22.23.3-bookworm-slim` for armv7. The bundled npm moved to 11.21.0 to pick up a fixed `tar`.

**Runtime advisories.** `proxy-addr` moved to 2.0.8 (GHSA-jqcg-44mw-7w3h) and `brace-expansion` to fixed versions. `npm audit --omit=dev` went from 17 findings with 1 critical to 15 with none critical. The rest are tracked as follow-ups: the socket.io stack, `qs`, `mysql2` and a few others.

## Do you need to do anything?

For most installs, no. Pull the new image and start it.

- **Existing volumes are fixed for you.** On the first start the entrypoint corrects the owner of any file in `/data` that has the wrong one, then records that it did. Later starts check only the top level, so a large volume is not walked every time.
- **`PUID` / `PGID`** still work. Changing them runs the ownership pass once more.
- **USB serial devices** keep working. The entrypoint adds `node` to each mapped device's group. This now also works on armv7, where it had silently failed, and it follows symlinks such as `/dev/serial/by-id/...`.

Check your setup if any of these apply:

- **You use `cap_drop: [ALL]`.** A root start now fails at the privilege drop, since dropping privileges needs `SETUID` and `SETGID`. Start the container unprivileged instead:

  ```yaml
  services:
    meshmonitor:
      user: "1000:1000"
      cap_drop: [ALL]
      security_opt:
        - no-new-privileges:true
  ```

  `NET_BIND_SERVICE` is not needed; every port MeshMonitor listens on is above 1024.

- **You set `user:` and use a serial device.** With `user:`, the entrypoint cannot add groups. Use `group_add` with the device's group id.
- **Your volume is not owned by uid 1000 and you set `user:`.** Nothing can fix ownership without root. `chown` the volume once, or start once without `user:`.
- **Kubernetes / Helm.** The chart already ran as uid 1000. It now also sets `runAsGroup: 1000` and `fsGroupChangePolicy: OnRootMismatch`, so a root-owned volume is fixed once and not on every start.

The full reference is in [Docker Security](/configuration/production#docker-security) and [Updating](/configuration/updating).

If something breaks, `RUN_AS_ROOT=true` brings back the old process users and prints a loud warning. It is there for troubleshooting. Please [open an issue](https://github.com/Yeraze/meshmonitor/issues) if you need it, so we can fix the real cause.

## Permissions and backups

Three more changes in 4.17.0 are worth an operator's time. None needs a new image setting, but each can change what a non-admin user sees.

**Permissions are checked on the source a request acts on.** Many routes checked a per-source permission against any source. A user with a grant on one source could read, change or send on another by naming it in the request. Every route now checks the source it acts on: device configuration, mesh requests, messages, channels, nodes, settings, telemetry, the v1 API, public embeds and the live WebSocket feed. Admins see no change. A user with limited grants may lose a page they should not have had; if they should have it, grant the permission on that source under Users.

**Connection details stay with those allowed to see them.** A user without `sources:read` no longer sees a node's address or a broker host. Broker URLs lose their credentials, and credential fields are masked for non-admins who can edit a source.

**A system backup is a secret, and only an admin can download one.** A backup now holds every table, with channel keys in the clear and password hashes. The download used to need only `configuration:read`. New backup files are readable only by the server's user. Store backups as you would store a password file.

Smaller items: Restart Container and the install-wide "run now" jobs are admin only, and `GET /api/status` no longer returns install-wide statistics without an admin login.

If you run a multi-user install, review each non-admin account after the upgrade. For a public map that draws route lines, grant `traceroute:read` to the anonymous account.

## What we did not fix

- **The scan numbers will not drop to zero.** Findings in the Node base image belong to the base image, and we take each new build as it lands.
- **LXC is unchanged.** The LXC template already ran as an unprivileged user. It keeps its dev dependencies because `meshmonitor-update` rebuilds in place.
- **The desktop app** is not a container and is not affected.

## Thanks

Thanks to DrivenMadz for running the scan, testing a patched image and sharing both. Reports like this one make the project safer. If you find something, [SECURITY.md](https://github.com/Yeraze/meshmonitor/blob/main/SECURITY.md) says how to report it.
