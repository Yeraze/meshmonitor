# Frequently Asked Questions

Short answers, each linking to the page with the detail. Developers: see [Development](/development/).

## Getting started

### What are the default login details?

On first start, MeshMonitor creates the user `admin` with password `changeme`. To pick your own, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (8+ characters) before the first start. Change the password once you log in. See [Getting Started](/getting-started#_4-login-with-default-credentials).

### I forgot the admin password. How do I reset it?

Run the reset script. It finds your database, unlocks the admin account and prints a new random password:

```bash
docker compose exec -u node meshmonitor node reset-admin.mjs
```

On bare metal, run `node reset-admin.mjs` in the install folder, with `DATABASE_URL` set for PostgreSQL or MySQL. To set another user's password, open **Users** in the sidebar, pick the user and click **Set Password**. See [Users page](/features/per-source-permissions#users-page).

### Can one MeshMonitor watch many nodes, MeshCore, MQTT or Reticulum?

Yes. Each connection is a **source**: a Meshtastic node, a MeshCore device, an MQTT broker or bridge, or Reticulum. Add one with the **+** in the Dashboard's Sources sidebar, no restart needed. `MESHTASTIC_NODE_IP` only seeds the first source. See [Multi-Source](/features/multi-source).

### Can I use a Bluetooth or USB radio?

Yes. A Meshtastic radio on Bluetooth needs the [BLE Bridge](/configuration/ble-bridge); one on USB needs the [Serial Bridge](/configuration/serial-bridge). Each bridge serves the radio on TCP port 4403. MeshCore devices connect over USB or TCP with no bridge. See [MeshCore](/features/meshcore).

### Do I need Docker?

No, though Docker Compose is the main install. You can also use the [Desktop app](/configuration/desktop) (Windows, macOS), [Proxmox LXC](/deployment/PROXMOX_LXC_GUIDE), [Helm](/deployment/HELM_GUIDE), or [bare metal](/deployment/DEPLOYMENT_GUIDE) on Node.js 22 or later. [Getting Started](/getting-started#deployment-methods) compares them.

### Can I use PostgreSQL or MySQL instead of SQLite?

Yes. SQLite is the default and needs no setup. For the others, set `DATABASE_URL` to a `postgres://` or `mysql://` URL; MeshMonitor creates its tables on first start. Switching starts an empty database; use the migration tool to copy SQLite data across. See [Choosing a Database](/configuration/database).

### Can I sign in with SSO?

Yes, through OpenID Connect (Keycloak, Authentik, Auth0 and others). Set the `OIDC_*` variables, and optionally map provider groups to admins. Local accounts can also use [passkeys](/features/passkeys). See [SSO Setup](/configuration/sso).

### I used to run MeshManager. Do I still need it?

No. Add each node as a [source](/features/multi-source). The built-in [Analysis Reports](/features/analysis-reports) cover solar monitoring, NodeInfo enrichment and ok_to_mqtt checks; **Solar Monitoring Analysis** replaces the old solar-forecast script.

## Access and login

### I see a blank white screen when accessing MeshMonitor {#i-see-a-blank-white-screen-when-accessing-meshmonitor}

You reached MeshMonitor from an address it does not allow, so the browser blocked the page (the F12 console says `blocked by CORS policy`). Only `http://localhost:8080` and `http://localhost:3001` work by default. List every address you use, then restart:

```yaml
environment:
  - ALLOWED_ORIGINS=http://192.168.1.50:8080,https://meshmonitor.example.com
```

If you change the published port, add the new address too. See [Reverse Proxy: Troubleshooting](/configuration/reverse-proxy#troubleshooting).

### Login works, then I am logged straight out {#i-can-t-login-session-immediately-logs-out}

The browser dropped the session cookie. With `COOKIE_SECURE=true` it sends the cookie only over HTTPS, so login fails over plain HTTP, or behind an HTTPS proxy when `TRUST_PROXY` is unset. Behind a proxy, set `TRUST_PROXY=1` and `COOKIE_SECURE=true`. On plain HTTP, leave `COOKIE_SECURE` unset (default `false`). The startup log shows `Cookie secure: true` or `false`. See [Reverse Proxy](/configuration/reverse-proxy) and [HTTP vs HTTPS](/configuration/http-vs-https).

### Two instances on one host log each other out

Browsers share cookies across ports on one host name, so the instances overwrite each other's `meshmonitor.sid` cookie and you get logouts or CSRF errors. Give each its own `SESSION_COOKIE_NAME`. One instance can usually hold all your sources instead. See [Environment Variables](/configuration/#environment-variables).

### Can I serve MeshMonitor under a path like /meshmonitor?

Yes. Set `BASE_URL=/meshmonitor` and point your reverse proxy at that path. See [Reverse Proxy](/configuration/reverse-proxy).

### How do I share a public map safely?

Grant the **anonymous** user **View on Map** on the channels to show ([below](#the-map-is-blank-for-anonymous-not-logged-in-users)). Then turn on [Public-Instance Mode](/features/public-instance-mode) to hide or blur names, exact positions, message text and keys for signed-out visitors and [embed maps](/features/embed-maps).

## Connecting to radios

### MeshMonitor can't connect to my Meshtastic node

Check that the node answers `ping`, that `nc -zv <node-ip> 4403` connects, that WiFi or Ethernet is on in its **Network** settings, and that no firewall blocks TCP 4403. If `meshtastic --host <node-ip>` also fails, the fault is on the node or network. If the link comes up and drops, see the next question.

### My Meshtastic TCP source keeps connecting and disconnecting {#my-meshtastic-tcp-source-keeps-connecting-and-disconnecting}

A Meshtastic node serves **one TCP client at a time**; a new client closes the old one's link. When this repeats, MeshMonitor logs:

```
Node closed the TCP link 3 times within seconds of connecting; another TCP client ... may be taking the node's single TCP slot.
```

Look for the other client: the phone app on WiFi (Bluetooth is fine), Home Assistant, Node-RED, the Python CLI or a script, a second MeshMonitor source with the same host and port (a host name and an IP for one node look different to MeshMonitor), or an old container on another machine. To spot one, run `tcpdump -n 'host <node-ip> and port 4403 and tcp[tcpflags] & tcp-syn != 0'`; the node's serial log prints `Force close previous TCP connection` too. If a large node drops the link during the first sync with no other client, turn on [Passive Mode](/features/multi-source#passive-mode). Connect phone apps to the Virtual Node instead.

### What does the Virtual Node do?

It lets Meshtastic apps connect to MeshMonitor (port 4404 by default) instead of the radio, so many clients share the node's one TCP slot. It blocks admin and NodeInfo packets from them. Since 4.18 a message sent from one app reaches the other apps, except a direct message the app encrypted itself (PKI). Frequent position packets come from the node's settings, not MeshMonitor. See [Virtual Node](/configuration/virtual-node).

### MQTT messages only show up when another node repeats them over LoRa

Your node gets nothing from the broker. Either **Proxy to Client** is on with no MQTT source linked (the source card says **MQTT not linked**), the channel lacks **Downlink Enabled**, or LoRa **Ignore MQTT** is on. See [Why don't I see MQTT traffic?](/features/mqtt-broker#why-no-mqtt-traffic).

### Does MeshMonitor use airtime on its own?

Features that send on a schedule are off until you turn them on, per source: auto traceroute, auto announce, auto acknowledge and responder, timers, automations, remote telemetry requests, and MeshCore room sync and neighbour polling. Each one takes airtime from everyone on the channel, so keep intervals long on a busy mesh. See [Automation](/features/automation) and [Reducing Node Load](/configuration/node-load).

## Maps, nodes and messages

### The map shows no nodes

Usual causes: the nodes have sent no position; **Maximum Node Age** hides nodes not heard lately; a filter such as **Hide incomplete nodes** or the MQTT toggle is on; the source picker shows another source; you lack **View on Map** on that channel; or tiles did not load (on an offline network, use a [custom tile server](/configuration/custom-tile-servers)). See [Maps](/features/maps).

### The map is blank for anonymous (not logged in) users {#the-map-is-blank-for-anonymous-not-logged-in-users}

Signed-out visitors use the **anonymous** user, which starts with no channel grants. As an admin, open **Users**, pick **anonymous**, choose a source, and tick **View on Map** (and **Read Messages**, if wanted) on each channel to show. Grants are per source, so repeat for each source. Changes apply at once.

### Understanding channel permissions {#understanding-channel-permissions}

Each channel on each source has three grants: **View on Map** (nodes last heard on it), **Read Messages** and **Send Messages**. View on Map works alone, which suits a public map. API tokens carry their user's permissions. See [Per-Source Permissions](/features/per-source-permissions).

### What do the icons in the node list mean?

The icons are line drawings; hover over one for a tooltip. In the **Map** tab's node list:

| Icon | Meaning |
|---|---|
| Star | Favorite (click to toggle) |
| Map pin | Has a position |
| Network | Heard through MQTT |
| Package | Store & Forward server |
| Bar chart / cloud and sun | Has telemetry / weather data |
| Lock with keyhole | Has a public key |
| Wrench | Remote admin verified |
| Plane | Likely an aircraft |
| Warning triangle | Key security issue |
| Wifi / radio tower | SNR / RSSI of last packet |
| Battery / link | Charge / hops away |

An identity badge marks a node renumbered by firmware 2.8. For map markers and role badges, see [Maps: Node Visualization](/features/maps#node-visualization).

### What do the message status icons mean?

On messages you send: a clock (sending), a check (sent to the mesh), a lock (target node confirmed, direct messages only), a timer (no acknowledgement in 30 seconds) or a red X (unconfirmed or routing error). A red X does not prove loss; acknowledgements get lost too. Click it for [Delivery Details](/features/delivery-diagnostics#status-and-what-this-means).

### What do Hops, SNR and RSSI mean?

**Hops** is how many nodes relayed a packet before your radio heard it; 0 means direct. **SNR** (dB) and **RSSI** (dBm) rate the last packet your radio heard from that node; higher is better. For a relayed packet they rate the last relay, not the sender. Meshtastic does not record the full path: run a traceroute, or see the last relay in the [Packet Monitor](/features/packet-monitor). See [Link Quality](/features/link-quality).

### Why can I read some "private" messages?

Your node decrypts direct messages sent to it before passing them on, so they arrive as plain text with an open lock. The lock shows who decrypted the message, not who could read it on air. MeshMonitor can also decrypt channels whose keys you add to the [Channel Database](/features/channel-database), and, if you opt in, [PKI direct messages](/features/pki-dm-decryption).

### What are the shaded areas and circles around some nodes?

They show where a node probably is (**Show Accuracy Regions** in the map features). A reduced-precision position gets a shaded box covering where the node could be. A node placed by [position estimation](/features/position-estimation) gets a dashed circle that shrinks as more nodes hear it. Node filters apply to both. See [Estimated Accuracy](/features/estimated-accuracy).

### I see pop-up toasts from my node

Your node reports on itself (duplicate keys, config errors, duty-cycle limits); MeshMonitor shows each message at most once a minute. If a toast says the protected-node list is full, the node refused a favorite or ignore, and MeshMonitor undoes the toggle.

## Firmware 2.8

Firmware 2.8.x ships as public alpha pre-releases; 2.7.x is the latest stable. These answers apply once you upgrade.

### Half my node list went dark and there are duplicates

2.8 derives node numbers from the public key, so each upgraded node shows up as new while the old entry ages out with its history. MeshMonitor badges both but never merges them on its own. An admin can choose **Merge history…** in **Node Details**, which shows a dry run and records an undo. Update automations and rules that name the old number. See [Node Number Changes](/features/node-identity-changes).

### My node stopped sharing position or telemetry

2.8 makes both opt-in. A fresh device starts with position off. On the first boot after upgrading, the firmware turns off position and telemetry broadcasts on default-key channels and the MQTT map-report location; private-key channels keep their settings. This runs once. Re-enable **position precision** and the telemetry **broadcast** options in the Meshtastic app. MeshMonitor keeps all history.

### My node count or a blocked node looks different

On nRF52, 2.8 keeps full detail for about 120 nodes on the device. MeshMonitor keeps its own history, so it may count more. A blocked node may drop off the device's list, but MeshMonitor stores blocks per source and reapplies them. See **Automation → Ignored Nodes**.

### What is MeshMonitor's firmware 2.8 early-preview support? {#firmware-2-8-early-preview}

MeshMonitor decodes a few 2.8 formats, built on pre-release definitions that may change:

- **Signed packets.** When the node reports a verified signature, a shield shows in the [Packet Monitor](/features/packet-monitor) and on messages. The node checks the signature, not MeshMonitor.
- **MeshBeacon.** The Packet Monitor shows beacons as `[MeshBeacon: "..."]`, and a beacon can [trigger an automation](/features/automation-engine); beacons are not stored as messages. Set the module up under **Device Configuration → MeshBeacon** or **Admin Commands**. Firmware silently drops a config with more than four targets or 100 bytes of text, so the editor blocks both.
- **MEDIUM_TURBO.** A new 500 kHz [modem preset](/features/device#modem-preset).

## Notifications

### Push notifications fail in Brave

In `brave://settings/privacy`, turn on **Use Google services for push messaging**, restart Brave and subscribe again. Or use [Apprise](/features/notifications), which does not need the browser.

### I get no notifications on my iPhone

iOS needs HTTPS, MeshMonitor added to the Home Screen, and a real address in **Contact Email (VAPID Subject)** (not `.local` or `localhost`). After changing the email, unsubscribe and subscribe again. See [iOS Setup](/features/notifications#ios-setup-step-by-step).

## Updates, backups and data

### How often does MeshMonitor release? What's the difference between :dev and :latest? {#how-often-does-meshmonitor-release}

| Tag | Track | Cadence |
|-----|-------|---------|
| `ghcr.io/yeraze/meshmonitor:latest` | Stable | about weekly |
| `ghcr.io/yeraze/meshmonitor:dev` | Release candidates and stable | about daily |

**`:latest`** is the default and moves only when a stable version ships. **`:dev`** moves with every release, so it is never older than `:latest`. Each release also gets an exact tag (such as `:4.18.0`) for pinning. To switch, change the `image:` tag and restart; [Watchtower](/configuration/updating#unattended-updates-with-watchtower) follows whatever tag you run.

### How do I update MeshMonitor?

On Docker, run `docker compose pull` then `docker compose up -d`. A banner tells you when a new version is out. For bare metal, LXC, Helm and Watchtower, see [Updating MeshMonitor](/configuration/updating).

### How do I back up my data?

Use **Settings → System Backup**: **Create Backup Now**, or daily automated backups. It covers all three databases; `RESTORE_FROM_BACKUP` restores on startup. Backups sit in `/data/system-backups/` and hold channel keys, so copy them off the host and guard them. Keep your compose file and `SESSION_SECRET` too. Never copy a live SQLite file. See [System Backup](/features/system-backup).

### How do I start over with an empty database?

Back up first. On Docker with SQLite, `docker compose down -v` deletes the data volume. On bare metal, delete `meshmonitor.db` and its `-wal` and `-shm` files. On PostgreSQL or MySQL, drop and recreate the database. MeshMonitor then recreates `admin` / `changeme`.

### I get permission errors on a NAS or bind mount

Since 4.17 everything in the container runs as the `node` user (uid and gid 1000). If your data folder belongs to someone else, set `PUID` and `PGID` to match; the entrypoint hands `/data` to that user on start. `docker exec` still runs as root, so add `-u node` when writing to `/data`. See [Upgrading to 4.17](/configuration/updating#upgrading-to-4-17-every-process-runs-as-node) and [Starting fully unprivileged](/configuration/production#starting-fully-unprivileged).

### My scripts lost their Python modules or API keys

Scripts no longer load modules from the scripts folder or see container variables named like secrets (`API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`). List modules in `/data/scripts/requirements.txt` and click **Install / Update dependencies**; they survive updates. For an API key, add it in **Settings › Scripts › Script Secrets** (needs `SESSION_SECRET` set in your environment): each secret reaches every script as an environment variable of the same name. Don't rename a container variable to get past the filter: the filter exists so an uploaded script can't read the server's own secrets. See [Script Secrets](/developers/auto-responder-scripting#script-secrets) and [User Scripts](/user-scripts#installing-dependencies).

### Docker's network clashes with my LAN

Docker picks a subnet for MeshMonitor's network that can overlap your LAN or VLANs. Pin a free one in your compose file, or set `default-address-pools` in Docker's `daemon.json`:

```yaml
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.250.0/24
```

## Performance and logs

### MeshMonitor is slow or the database is huge

Turn on [Database Maintenance](/features/settings#database-maintenance) in **Settings**. It is off by default; once on, it deletes old data nightly and compacts the database. Check memory with `docker stats`. For a strained node, see [Reducing Node Load](/configuration/node-load) and [Auto Heap Management](/features/auto-heap-management).

### Where are the logs?

On Docker, run `docker compose logs -f meshmonitor`. On bare metal, logs go to whatever started MeshMonitor. The desktop app keeps them in its [data folder](/configuration/desktop#data-files). Set `LOG_LEVEL=debug` for more.

### Times in logs or schedules are wrong

The server uses `TZ` (such as `TZ=Europe/London`) for logs, schedules and scripts, and UTC without it. The browser shows times in your own time zone. If new data has future dates, check your node's clock. See [Custom Timezone](/getting-started#custom-timezone).

## Getting help

Search [GitHub Issues](https://github.com/yeraze/meshmonitor/issues). When you open one, include your version (under **Info**), relevant logs, how you deploy, and your compose file with secrets removed.
