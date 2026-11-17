# Frequently Asked Questions (FAQ)

This page covers common issues and questions from MeshMonitor users. For developer-specific questions, see the [Development Documentation](/development/).

## Common Issues

### I see a blank white screen when accessing MeshMonitor

**Problem:** You can access MeshMonitor's URL, but the page is completely blank or you see CORS errors in the browser console.

**Cause:** This is a **CORS (Cross-Origin Resource Sharing)** issue. MeshMonitor blocks requests from unauthorized origins for security.

**Solution:** Set the `ALLOWED_ORIGINS` environment variable:

```yaml
environment:
  - MESHTASTIC_NODE_IP=192.168.1.100
  - ALLOWED_ORIGINS=http://192.168.1.50:8080  # Replace with your server's IP
```

**Common scenarios:**

1. **Accessing from another device on your network:**
   ```yaml
   - ALLOWED_ORIGINS=http://192.168.1.50:8080
   ```

2. **Using a custom domain:**
   ```yaml
   - ALLOWED_ORIGINS=https://meshmonitor.example.com
   ```

3. **Multiple access methods (comma-separated):**
   ```yaml
   - ALLOWED_ORIGINS=http://192.168.1.50:8080,http://meshmonitor.local:8080,https://meshmonitor.example.com
   ```

**Note:** Only `http://localhost:8080` and `http://localhost:3001` are allowed by default. Any other origin, including localhost on another port, must be listed.

If the login page warns about secure cookies, or you can log in but get sent straight back, see [I can't login / Session immediately logs out](#i-can-t-login-session-immediately-logs-out).

**How to diagnose:**
1. Open your browser's Developer Tools (F12)
2. Check the Console tab for errors like:
   - `Access to fetch at 'http://...' from origin 'http://...' has been blocked by CORS policy`
   - `No 'Access-Control-Allow-Origin' header is present`

**After fixing:**
```bash
docker compose down
docker compose up -d
```

---

### I can't login / Session immediately logs out

**Problem:** You enter your username and password, the login appears to succeed, but you're immediately logged out or redirected back to the login page.

**Cause:** The browser drops the session cookie. With `COOKIE_SECURE=true`, MeshMonitor marks the cookie secure and only sends it on a request it sees as HTTPS. That fails in two cases:

- You reach MeshMonitor over plain HTTP.
- A reverse proxy handles HTTPS, but `TRUST_PROXY` is not set, so MeshMonitor sees the proxy's plain HTTP request and ignores its `X-Forwarded-Proto` header.

`COOKIE_SECURE` defaults to `false`, so a plain HTTP install with no proxy works without it. MeshMonitor does not serve HTTPS itself; for HTTPS, put a reverse proxy in front.

**Solution:** The fix depends on your deployment.

#### Behind an HTTPS reverse proxy (recommended)

For nginx, Caddy, Traefik or similar with HTTPS:

```yaml
environment:
  - NODE_ENV=production
  - TRUST_PROXY=1                 # one proxy hop; required
  - COOKIE_SECURE=true            # required over HTTPS
  - SESSION_SECRET=your-secret-here
  - ALLOWED_ORIGINS=https://meshmonitor.example.com
```

See [Reverse Proxy Configuration](/configuration/reverse-proxy) for proxy setups and [HTTP vs HTTPS](/configuration/http-vs-https) for the trade-offs.

#### Plain HTTP (no proxy)

Remove `COOKIE_SECURE=true` if you set it, or set it to `false`. Use this on a trusted LAN only; anyone on the network can read a cookie sent over HTTP.

**How to diagnose:**
1. Check the startup log. MeshMonitor prints `Cookie secure: true` or `false` under `Session configuration`.
2. Open browser Developer Tools (F12), go to **Application → Cookies**, and log in.
3. If no `meshmonitor.sid` cookie appears (or the name you set in `SESSION_COOKIE_NAME`), the cookie was dropped. Match `COOKIE_SECURE` to how you reach MeshMonitor, and set `TRUST_PROXY` behind a proxy.

**After fixing:**
```bash
docker compose down
docker compose up -d
```

---

## Node Management

### Can I monitor multiple nodes (or multiple mesh protocols) with one MeshMonitor instance?

**Yes.** As of 4.0, a single MeshMonitor instance is **multi-source** — it can connect to many Meshtastic nodes, MeshCore devices, and MQTT brokers at the same time.

**How:** Each upstream connection is a **source** stored in the database. Sources are added, edited, or removed from **Dashboard → Sources** without restarting the container. Every source has its own Virtual Node, scheduler, auto-responder, permissions, and per-source views (maps, messages, telemetry, traceroutes), and there's a **unified** mode that aggregates across all of them.

See [Multi-Source](/features/multi-source) for the full feature description.

**Why you might still run multiple instances:** strict tenant isolation (separate databases per organization), separate update schedules, or running different MeshMonitor versions side by side. For most users, a single multi-source instance is the right answer — add nodes from the UI rather than spinning up a second container.

**Bootstrap:** The `MESHTASTIC_NODE_IP` / `MESHTASTIC_TCP_PORT` env vars only seed the **first** source on first boot. Add additional sources (and additional protocols) from the dashboard:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # Seeds source #1 on first boot
      - ALLOWED_ORIGINS=http://192.168.1.50:8080
    restart: unless-stopped

volumes:
  meshmonitor-data:
```

Then open **Dashboard → Sources → +** to add a second Meshtastic node, a MeshCore device, or an MQTT broker.

---

### I get CSRF errors when running multiple MeshMonitor instances on the same host

::: tip First, do you actually need multiple instances?
Since 4.0, one MeshMonitor instance is multi-source and can talk to many Meshtastic, MeshCore, and MQTT sources at once. The setup below only applies if you deliberately run multiple instances (e.g. tenant isolation, different versions).
:::

**Problem:** When running multiple MeshMonitor instances on the same host (same IP/domain, different ports), you experience random logouts, CSRF validation failures, or session conflicts.

**Cause:** This is a **session cookie conflict**. Browsers identify cookies by domain/hostname, not by port. When multiple instances use the same default session cookie name (`meshmonitor.sid`), they share and overwrite each other's session cookies, causing authentication conflicts.

**Solution:** Set a unique `SESSION_COOKIE_NAME` for each instance:

```yaml
services:
  meshmonitor-node1:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor-node1
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-node1-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - ALLOWED_ORIGINS=http://192.168.1.50:8080
      - SESSION_COOKIE_NAME=meshmonitor-node1.sid  # Unique name!
    restart: unless-stopped

  meshmonitor-node2:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor-node2
    ports:
      - "8081:3001"
    volumes:
      - meshmonitor-node2-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.101
      - ALLOWED_ORIGINS=http://192.168.1.50:8081
      - SESSION_COOKIE_NAME=meshmonitor-node2.sid  # Different name!
    restart: unless-stopped

volumes:
  meshmonitor-node1-data:
  meshmonitor-node2-data:
```

**Why this works:**
- Each instance now uses a different cookie name
- Browser stores separate cookies for each instance
- Sessions no longer conflict or overwrite each other
- Each instance maintains independent authentication state

**How to diagnose:**
1. Open browser Developer Tools (F12)
2. Go to Application tab → Cookies
3. Check if you see only one `meshmonitor.sid` cookie (indicates conflict)
4. After fix, you should see multiple cookies with unique names (e.g., `meshmonitor-node1.sid`, `meshmonitor-node2.sid`)

**After fixing:**
```bash
docker compose down
docker compose up -d
```

**Note:** This issue only occurs when running multiple instances on the **same hostname** (e.g., `192.168.1.50:8080` and `192.168.1.50:8081`). If instances use different hostnames (e.g., `meshmonitor1.local` and `meshmonitor2.local`), they automatically have separate cookies and don't need custom names.

---

### My node count or a blocked node looks different after upgrading to firmware 2.8

Meshtastic firmware 2.8 reorganizes how a device stores its node database, but **none of this changes what MeshMonitor records.** MeshMonitor keeps its own persistent history of every node it has heard, independent of how many the device holds at any moment.

Two things you might notice:

- **Lower "nodes" count on the device, not in MeshMonitor.** On nRF52 hardware, 2.8 keeps full detail for ~120 recent nodes (down from 150); older ones become compact records on the device. The device's own app may show fewer nodes, but **MeshMonitor's counts are unaffected** — and can be higher than the device's, because MeshMonitor remembers nodes the device has compacted.
- **A blocked node is blocked, not gone.** Under 2.8 a device protects blocked nodes from being dropped and may stop listing them in full node queries. MeshMonitor stores its block list per source and re-applies it automatically, so a blocked node stays blocked even if it disappears from the device's node list. To review or un-block, open the **Automation** tab and go to **Ignored Nodes**.

---

### Half my node list went dark after a firmware 2.8 upgrade, and there are duplicates

This is expected. **Firmware 2.8 changes how a node picks its node number** — it is now derived from the node's public key instead of the hardware MAC address — so every node that upgrades gets a **new node number** and shows up in MeshMonitor as a brand-new node.

What you see:

- The old entry stops updating and ages out like any silent node.
- A new entry appears with the same long and short name, a new node ID, and no history.
- Telemetry, positions, packet logs and messages recorded before the upgrade stay attached to the **old** node number. Nothing is lost, but it is no longer reachable from the new entry.

MeshMonitor detects the likely pairing and marks **both** entries with an identity badge in the node list — the new one says which node it used to be, the silent one says what it continued as. Open **Node Details** on either for the full explanation, including what the pairing was based on.

MeshMonitor **never merges the two on its own**. When the pairing rests on a name match it is a guess, and a wrong merge would splice two unrelated nodes' histories together.

If you are sure the pair is right, an admin can open **Node Details** on either entry and choose **Merge history…**. The dialog first shows a dry run of what will move, runs the merge in one transaction on that source only, and records an undo (unless the merge is too large to journal, which the dialog warns about). See [Merging the history](/features/node-identity-changes#merging-the-history).

You can also do nothing: let the old entry age out and let new history build up. Either way, if you referenced the node in an automation, a notification rule, or an auto-traceroute or auto-favourite list, update those to the new node number. A merge does not move them, and they will otherwise keep pointing at the silent old entry.

Full details, including how the pairing is worked out and why a duplicate-key security warning may appear briefly: [Node Number Changes (Meshtastic 2.8)](/features/node-identity-changes).

---

### My node stopped sharing position or telemetry after upgrading to firmware 2.8

Firmware 2.8 makes position and telemetry broadcast **opt-in**. If a node goes quiet on the map or stops reporting telemetry after the upgrade, this is **expected firmware behavior, not a MeshMonitor bug** — the device is no longer broadcasting that data by default.

::: info 2.8 is a pre-release
Firmware 2.8.x is out as public alpha pre-releases; the latest stable release is still 2.7.x. This applies only once you upgrade to 2.8.
:::

What 2.8 changes:

- **Fresh flash: position precision defaults to off.** Previously a new device broadcast a reduced-precision position out of the box (position precision 13); on 2.8 it defaults to **off**, so a freshly flashed node shares no location until you enable it.
- **First boot after upgrading runs a one-time migration.** On the first boot after the upgrade, the firmware **disables position broadcast and all five telemetry mesh-broadcast types** (device, environment, air quality, power, and health metrics) — but **only on public / default-PSK channels**. Channels using a **private PSK keep their existing settings** untouched.
- **MQTT map-report location is switched off.** The map-report **location** is turned off, while map reporting itself stays enabled — so the node **remains on the map anonymously, just without a location**.
- **The migration runs only once.** Anything you re-enable afterward **stays enabled** — the firmware won't turn it off again on later boots.

**To restore sharing**, re-enable it in the Meshtastic app:

1. **Position** — under Position settings, set a **position precision** to start broadcasting location again.
2. **Telemetry** — under the Telemetry module, re-enable the **broadcast** options for the metric types you want to share (device, environment, air quality, power, health).

MeshMonitor **keeps all previously collected history** — nothing you already gathered is lost. Only **new** position and telemetry updates stop arriving until you re-enable them on the device.

---

### What is MeshMonitor's "firmware 2.8 early preview" decode support? {#firmware-2-8-early-preview}

::: info 2.8 is a pre-release
As above, firmware 2.8.x ships only as public alpha pre-releases so far (the latest stable is 2.7.x). MeshMonitor decodes a few 2.8-only wire formats now, built against pre-release protobuf definitions that may still change.
:::

A few things you may notice on a 2.8 pre-release:

- **Signed-packet shield.** Firmware 2.8 introduces an **XEdDSA** packet-signing scheme. When the connected node reports a packet as signature-verified, MeshMonitor shows a small shield icon next to it, in the [Packet Monitor](/features/packet-monitor), and alongside the existing MQTT and store-and-forward indicators on messages. MeshMonitor doesn't verify the signature itself; it only surfaces what the node already checked.
- **MeshBeacon.** 2.8 adds a periodic `MESH_BEACON_APP` broadcast that a node can use to advertise a joinable channel (name, region, and modem preset). The Packet Monitor decodes and previews these as `[MeshBeacon: "..."]`. You can also:
  - **Configure the module** from Device Configuration → MeshBeacon, or the Admin Commands tab: listen and broadcast toggles, the beacon text, the broadcast interval, what network (if any) to advertise, and a **Broadcast Targets** list naming where the beacon is transmitted. Each target picks a modem preset, a region, and one of the node's own channel slots; leave the list empty to send a single beacon on the node's running preset and region over the primary channel. Firmware accepts at most four targets and 100 bytes of beacon text — go over either and the device discards the whole MeshBeacon config without reporting an error, so MeshMonitor blocks both in the editor. The section is greyed out on firmware older than 2.8, because such a device silently ignores the setting rather than rejecting it.
  - **Trigger an automation** on a received beacon, optionally filtered by beacon text or narrowed to beacons that actually advertise a network. See [Automations](/features/automation-engine).

  Beacons are **not** stored as messages, they appear in the Packet Monitor and can drive automations.
- **MEDIUM_TURBO modem preset.** A new 500 kHz "medium range, turbo" preset appears alongside the existing presets in configuration screens that list modem presets. See [Modem Preset](/features/device#modem-preset).

Apart from the MeshBeacon module settings, none of this needs any action from you, it's decode support so MeshMonitor stays useful against nodes running 2.8 pre-releases. Expect this section to be replaced with normal release documentation once a stable 2.8 ships.

---

## User Management

### How do I reset a user's password as an admin?

1. Log in with an admin account.
2. Open **Users** in the Admin section of the sidebar.
3. Select the user and click **Set Password**.
4. Enter a new password (at least 8 characters) twice and save.
5. Give the user the password and ask them to change it after they log in.

Any admin can set any local user's password, including another admin's, unless the account's password is locked. SSO users sign in through their provider and have no MeshMonitor password. Setting a password also turns password sign-in back on for a user who had it disabled. See [Users page](/features/per-source-permissions#users-page).

---

### I forgot the admin password - how do I reset it?

**Problem:** You've lost access to the admin account and can't login.

**Solution:** Use the built-in password reset script to reset the admin password without losing any data. The script automatically detects your database backend (SQLite, PostgreSQL, or MySQL) and uses the correct driver.

#### For Docker Deployments (SQLite — default):

```bash
docker compose exec -u node meshmonitor node reset-admin.mjs
```

`-u node` runs the script as the same user as the server, so it cannot leave a
root-owned database file behind (`exec` otherwise defaults to root).

#### For Docker Deployments (PostgreSQL or MySQL):

The script reads `DATABASE_URL` from the container environment, so it works automatically:

```bash
docker compose exec -u node meshmonitor node reset-admin.mjs
```

#### For Bare Metal Deployments:

```bash
# SQLite (default — uses DATABASE_PATH or /data/meshmonitor.db)
node reset-admin.mjs

# PostgreSQL
DATABASE_URL=postgres://user:pass@localhost:5432/meshmonitor node reset-admin.mjs

# MySQL
DATABASE_URL=mysql://user:pass@localhost:3306/meshmonitor node reset-admin.mjs
```

The script will generate a new random password and display it:

```
Detected database: sqlite
═══════════════════════════════════════════════════════════
🔐 Admin password has been reset
═══════════════════════════════════════════════════════════
   Username: admin
   Password: <new-random-password>

   ⚠️  IMPORTANT: Save this password now!
═══════════════════════════════════════════════════════════
```

The script also ensures the admin account is active and not locked, so it will fix accounts that were accidentally disabled.

After running this, log in with the new password and change it to something memorable in the Users tab.

::: tip
The application must have been started at least once before running this script, so that the default admin account exists in the database.
:::

---

### I need to completely reset MeshMonitor - how do I wipe the database?

::: warning
This deletes ALL data, including messages, nodes, user accounts and settings. Take a [System Backup](/features/system-backup) first, and copy it off the host: on Docker the backups live in the same `/data` volume you are about to delete.
:::

#### For Docker Deployments (SQLite, the default)

```bash
# Stop MeshMonitor and delete its named volumes (this deletes ALL data!)
docker compose down -v

# Start MeshMonitor with an empty database
docker compose up -d
```

`down -v` removes every named volume in that compose file, so you don't need to know the volume's name.

#### For Bare Metal Deployments (SQLite)

Stop MeshMonitor, then delete the database file and its WAL side files. The path is `$DATABASE_PATH` if set, else `$DATA_DIR/meshmonitor.db`, else `/data/meshmonitor.db`:

```bash
rm -f /data/meshmonitor.db /data/meshmonitor.db-wal /data/meshmonitor.db-shm
```

Then start MeshMonitor again.

#### PostgreSQL or MySQL

The data lives in your database server, not in the MeshMonitor volume. Drop and recreate the MeshMonitor database there, then restart MeshMonitor.

**After wiping:**
- MeshMonitor creates a new database.
- It recreates the admin account: username `admin`, password `changeme` (or the value of `ADMIN_PASSWORD`, if set, on that first boot).

---

## Updates & Maintenance

### How often does MeshMonitor release? What's the difference between :dev and :latest? {#how-often-does-meshmonitor-release}

MeshMonitor publishes two rolling Docker image tags, letting you choose your upgrade cadence:

| Tag | Track | Typical cadence | Stability |
|-----|-------|-----------------|-----------|
| `ghcr.io/yeraze/meshmonitor:latest` | **Stable** | ~weekly | Production-ready releases |
| `ghcr.io/yeraze/meshmonitor:dev` | **RC / fast-track** | ~daily | Release candidates — may include work-in-progress |

**`:latest`** is the default and is recommended for most users. It moves only when a stable version ships, so you get a tested build and fewer surprise updates.

**`:dev`** moves with **every release** — release candidates *and* stable releases. It's useful if you want new features or fixes immediately and are comfortable with RC stability. Because stable releases are promoted to `:dev` as well, the fast track is always a superset of the stable track: `:dev` is never older than `:latest`, and it never moves backwards.

In addition to these rolling tags, every release (stable and RC) gets an **exact version tag** (e.g. `:4.13.0`, `:4.13.0-rc3`) for pinning, and stable releases also move the **major** (`:4`) and **major.minor** (`:4.13`) tags for Kubernetes-style rolling upgrades within a version line.

**Why two tracks?** Earlier versions of MeshMonitor released frequently, which created maintenance burden for users on automated upgrade tools. The two-track strategy lets you explicitly opt in to fast updates (`:dev`) or stay on a quieter stable cadence (`:latest`).

To switch tracks on a Docker Compose deployment, update the `image:` tag in your `docker-compose.yml` and restart the container. If you use [Watchtower for unattended updates](/configuration/updating#unattended-updates-with-watchtower), it automatically follows whichever tag your container runs — switching the `image:` tag switches your track there too.

---

### How do I update MeshMonitor to the latest version?

#### For Docker Deployments

```bash
docker compose pull
docker compose up -d
```

Check the new version under **Info** in the app. MeshMonitor also shows a banner when a new version is out.

For bare metal, LXC/Proxmox, Helm, unattended updates with Watchtower, and cleanup after the retired auto-upgrade sidecar, see [Updating MeshMonitor](/configuration/updating).

---

### How do I back up my MeshMonitor data?

Use the built-in **System Backup**. Go to **Settings → System Backup** and click **Create Backup Now**, or turn on **Automated Backups** for a daily backup. It works on SQLite, PostgreSQL and MySQL, and you can restore on startup with `RESTORE_FROM_BACKUP`. See [System Backup & Restore](/features/system-backup).

Backups are written to `/data/system-backups/`, inside the same volume as the database. Download them, or copy that folder off the host, so a lost disk or a deleted volume does not take them too.

A backup holds channel keys in the clear, so store it like a password file.

**Not in a backup:** your environment variables and `docker-compose.yml`. Keep a copy of those yourself, above all `SESSION_SECRET`: some rows in the backup are encrypted with it.

**Copying the SQLite file by hand:** don't copy or `tar` the database while MeshMonitor runs. It uses WAL mode, so a live copy can miss recent writes or come out corrupt. Stop MeshMonitor first, then copy `meshmonitor.db` along with any `meshmonitor.db-wal` and `meshmonitor.db-shm` files. The default path is `/data/meshmonitor.db` (or `$DATABASE_PATH`, or `$DATA_DIR/meshmonitor.db`). For scripted database dumps, see [Production: Backups](/configuration/production#backups).

---

## Network & Connectivity

### MeshMonitor can't connect to my Meshtastic node

::: tip Connecting MeshCore or MQTT instead?
The steps below apply to a Meshtastic TCP source. For MeshCore see [MeshCore](/features/meshcore); for MQTT see [Embedded MQTT Broker](/features/mqtt-broker) or check broker host, port, and credentials in **Dashboard → Sources → Edit**.
:::

**Checklist:**

1. **Verify IP address:**
   ```bash
   ping 192.168.1.100  # Use your node's IP
   ```

2. **Check TCP port 4403 is accessible:**
   ```bash
   telnet 192.168.1.100 4403
   # Or use: nc -zv 192.168.1.100 4403
   ```

3. **Ensure node has network connectivity enabled:**
   - Open Meshtastic app
   - Go to Settings → Radio Configuration → Network
   - Verify WiFi or Ethernet is enabled
   - Check that TCP is enabled

4. **Check firewall rules:**
   - Allow incoming TCP connections on port 4403
   - Check both node firewall and network firewall

5. **Verify in MeshMonitor:**
   - Check header for connection status
   - Click node name to see connection details
   - Check browser console (F12) for errors

**Still not working?**
- Try connecting with the official Meshtastic Python CLI to verify the node is accessible:
  ```bash
  pip install meshtastic
  meshtastic --host 192.168.1.100
  ```

---

### My Meshtastic TCP source keeps connecting and disconnecting

A Meshtastic node serves **one TCP client at a time**. When a second client connects, the node closes the first one's link. If two clients point at one node, they keep knocking each other off, and the link drops seconds after each connect.

MeshMonitor logs this warning when the node closes the link within seconds of connecting several times in a row:

```
Node closed the TCP link 3 times within seconds of connecting; another TCP client ... may be taking the node's single TCP slot.
```

Look for the other client:

- The Meshtastic phone app connected to the node over WiFi (Bluetooth does not use the TCP slot).
- Home Assistant, Node-RED, the Python CLI (`meshtastic --host`), or a script.
- A second MeshMonitor source with the same host and port. MeshMonitor logs a warning at startup when two enabled sources share one, but it cannot tell that a host name and an IP address are the same node.
- An old MeshMonitor container still running on another machine.

To catch a client on another machine, watch new connections to the node from your router or any host on the same network:

```bash
tcpdump -n 'host 192.168.1.100 and port 4403 and tcp[tcpflags] & tcp-syn != 0'
```

The node's serial log also prints `Force close previous TCP connection` each time a new client takes the slot.

If the node is large and closes the link during the initial sync even with no other client, turn on [Passive Mode](/features/multi-source#passive-mode) for the source.

---

### MQTT messages only show up when another node repeats them over LoRa

Your node is not getting the packets from the broker. The usual causes:

- **Proxy to Client** is on and no MQTT source is linked to the node, so nothing carries MQTT for it. The source's dashboard card shows **MQTT not linked**.
- The channel does not have **Downlink Enabled**.
- LoRa **Ignore MQTT** is on.

See [Why don't I see MQTT traffic?](/features/mqtt-broker#why-no-mqtt-traffic) for the fix and a test that tells the cases apart. To log everything on a broker, add an MQTT Bridge source instead of relying on a radio.

---

### Can I use MeshMonitor with a Bluetooth or Serial Meshtastic device?

**Yes!** The solution depends on your connection type:

#### For Bluetooth Low Energy (BLE) Devices

Use the [MeshMonitor BLE Bridge](https://github.com/Yeraze/meshtastic-ble-bridge) to create a TCP-to-BLE gateway:

```bash
# Create .env file with your device's BLE MAC address
echo "BLE_ADDRESS=AA:BB:CC:DD:EE:FF" > .env

# Start MeshMonitor with BLE bridge
docker compose -f docker-compose.yml -f docker-compose.ble.yml up -d
```

The BLE bridge connects to your Bluetooth Meshtastic device and exposes it on TCP port 4403 for MeshMonitor.

See [BLE Bridge](/configuration/ble-bridge) for setup, or the [BLE Bridge repository](https://github.com/Yeraze/meshtastic-ble-bridge).

#### For Serial/USB Devices

Use the [Meshtastic Serial Bridge](/configuration/serial-bridge) to create a TCP-to-Serial gateway:

```bash
# Create docker-compose.yml with serial-bridge
cat > docker-compose.yml << 'EOF'
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    container_name: meshtastic-serial-bridge
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0  # Change to your device
    ports:
      - "4403:4403"
    restart: unless-stopped

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=serial-bridge
    depends_on:
      - serial-bridge
EOF

docker compose up -d
```

The serial bridge connects to your USB/Serial Meshtastic device and exposes it on TCP port 4403 for MeshMonitor.

See the [Serial Bridge configuration guide](/configuration/serial-bridge) for detailed setup instructions.

---

## Interface & Features

### I used to run MeshManager — are its features in MeshMonitor?

Yes. MeshManager is winding down, and MeshMonitor now does its main jobs on its own:

- **Many nodes at once** — add each node as a [source](/features/multi-source) and watch them all from one place.
- **Analysis reports** — the built-in [Analysis Reports](/features/analysis-reports) cover solar monitoring, NodeInfo enrichment, and ok_to_mqtt checks. The **Solar Monitoring Analysis** report finds solar nodes and projects battery state, so you no longer need the old MeshManager solar-forecast script.

You do not need a running MeshManager instance for any of this.

### What do the icons in the Node List mean?

In the node list on the **Map** tab, you'll see various icons next to each node that indicate different statuses and capabilities:

#### Connection & Network Icons

- **🌐 Globe (MQTT)** - Node is connected via MQTT instead of direct LoRa/RF
  - Indicates the node was witnessed through an MQTT broker
  - Can be filtered on the map using the "Show MQTT" checkbox

#### Status Icons

- **⭐ Star (Favorite)** - Node marked as favorite
  - Click the star to toggle favorite status
  - Favorites appear at the top of sorted lists

#### Capability Icons

- **📍 Location** - Node has GPS position data
  - Shows latitude/longitude coordinates
  - Node will appear on the map
  - **🚶 Walking (Mobile)** - Position varies more than 1km (mobile node)

- **📊 Telemetry** - Node has telemetry data available
  - Click node to view detailed graphs
  - Shows battery, voltage, temperature, etc.

- **☀️ Weather** - Node has weather/environmental data
  - Temperature, humidity, pressure, etc.
  - Available from supported environmental sensors

- **🔐 PKC** - Node supports Public Key Cryptography
  - Enables encrypted communications
  - Part of Meshtastic security features

#### Other Indicators

- **🪪 Identity (Node number changed)** - This node is likely the same physical node as another entry, whose number changed on the firmware 2.8 upgrade
  - Appears on **both** halves of the pair: the new entry and the silent old one
  - Hover for the paired node's name, or open Node Details for the full explanation
  - The badge itself merges nothing; an admin can merge the two from Node Details with **Merge history…**. See [Node Number Changes (2.8)](/features/node-identity-changes#merging-the-history)

- **📶 Signal Strength** - Shows SNR (Signal-to-Noise Ratio) in dB
- **🔋 Battery Level** - Current battery percentage
- **🔌 Plugged In** - Node is powered (shows when battery = 101%)
- **🔗 Hops** - Number of hops away from your node

#### Node Roles

Nodes may also display role badges:
- **CLIENT** - Standard mesh client
- **ROUTER** - Dedicated router node
- **REPEATER** - Message repeater
- **TRACKER** - GPS tracker device
- **SENSOR** - Environmental sensor node
- **TAK** - TAK (Team Awareness Kit) integration

**Tip:** Hover over any icon to see a tooltip with more details!

### What do the message delivery status icons mean?

When you send a message, a status icon appears next to it showing the delivery state:

| Icon | Status | Meaning |
|------|--------|---------|
| ⏳ | **Pending** | Message is being sent, awaiting acknowledgment |
| ✅ | **Delivered** | Message has been transmitted to the mesh network |
| 🔒 | **Confirmed** | Message was received by the target node (direct messages only) |
| ⏱️ | **Timeout** | No acknowledgment received after 30 seconds |
| ❌ | **Failed** | Message failed to send due to a routing error or max retries exceeded |

**Note:** Status icons only appear on messages you send. Hover over any icon to see a tooltip with more details.

---

### The map doesn't show any nodes

**Possible causes:**

1. **Nodes don't have GPS coordinates:**
   - Check if nodes have reported position data
   - Check the node list on the **Map** tab to see which nodes have coordinates
   - Nodes without GPS won't appear on the map

2. **Browser location permissions:**
   - Some map features require location permission
   - Check browser settings to allow location access

3. **Map tiles not loading:**
   - Check browser console (F12) for errors
   - Verify internet connection (map tiles load from OpenStreetMap)

---

### The map is blank for anonymous (not logged in) users

**Problem:** When accessing MeshMonitor without logging in, the map appears empty even though logged-in users can see nodes.

**Cause:** **Channel permissions** control which nodes a user sees. Each node belongs to the channel it was last heard on, and a user (including the anonymous user) sees only nodes on channels they may view on the map. Grants are **per source**: a grant on one source opens nothing on another. By default, the anonymous user has no channel permissions.

**Solution:** Grant channel permissions to the anonymous user:

1. Log in as an admin and open **Users** in the Admin section of the sidebar.
2. Select the user named **anonymous**.
3. Choose the source in the permission scope selector.
4. For each channel you want visitors to see, tick **View on Map**. Tick **Read Messages** too if they should see that channel's messages.
5. Save, then repeat steps 3-4 for every other source you want to open.

To hide exact positions, names or keys from visitors while still showing the map, turn on [Public-Instance Mode](/features/public-instance-mode).

See [Understanding Channel Permissions](#understanding-channel-permissions) below for what each permission does.

---

### Understanding Channel Permissions

Each channel on each source has three permissions:

| Permission | Description |
|------------|-------------|
| **View on Map** | See nodes heard on this channel on the map |
| **Read Messages** | Read this channel's messages in the **Channels** tab |
| **Send Messages** | Send messages to this channel |

Each node belongs to the channel it was last heard on, and **View on Map** works on its own, without **Read Messages**. That makes it the one most public dashboards need.

**Example configurations:**

| Use Case | View on Map | Read Messages | Send Messages |
|----------|-------------|---------------|---------------|
| Public map-only dashboard | Yes | No | No |
| Read-only access (map + messages) | Yes | Yes | No |
| Full access | Yes | Yes | Yes |
| Hidden channel (logged-in users only) | No | No | No |

**Configuring the anonymous user:**

The **anonymous** user controls what signed-out visitors can see. Common setups:

- **Public dashboard:** tick **View on Map** on Channel 0 (Primary) for anonymous, on each source you want public.
- **Private network:** leave everything off; visitors must log in.
- **Selective exposure:** tick **View on Map** only on chosen public channels.

**Important notes:**

- Grants are per source. A user with access to one source sees nothing from another until you grant it there too.
- Changes take effect at once; no restart or new login needed.
- API tokens follow the permissions of the user they belong to, including in the V1 API.

For the full permission model, see [Per-Source Permissions](/features/per-source-permissions).

---

### How do I send messages to a specific channel?

1. Open the **Channels** tab.
2. Pick the channel.
3. Type your message and press Enter or click Send.

You can only send on channels configured on your connected node, and only with **Send Messages** permission on that channel. Virtual channels that the server decrypts are read-only.

---

## Notifications

### I see pop-up toasts with messages from my node (duty cycle, config errors, etc.)

MeshMonitor surfaces **device notifications** — short warning/info messages that your connected Meshtastic node sends about its own operation — as pop-up toasts in the top-right corner. Examples include duplicate-key security warnings, invalid-config errors, duty-cycle limits, and (on firmware 2.8+) a notice when a favorite/ignore couldn't be saved because the node's protected-node list is full.

These messages were always sent by the node; earlier MeshMonitor versions simply ignored them. To avoid noise, MeshMonitor drops the routine recurring ones (e.g. the power-saving "sleeping for N interval" message) and shows an identical message at most once per minute per source. The notifications come from the node MeshMonitor is connected to — there is no setting to forward arbitrary mesh traffic here.

If a "Set Favorite"/"Ignore" toast says the protected-node limit was reached, the node refused the change and MeshMonitor reverts the star/ignore toggle to match. This refusal warning is only emitted for your locally-connected node, not for remote-admin targets.

---

### Push notifications don't work in Brave browser

**Problem:** When trying to subscribe to Web Push notifications in Brave browser, you get an error like `Registration failed - push service error`.

**Cause:** Brave browser requires Google push services to be enabled for Web Push notifications to work.

**Solution:**

1. **Enable Google Services for Push Messaging:**
   - Open Brave Settings: `brave://settings/privacy`
   - Scroll down to the **"Web3"** or **"Privacy and Security"** section
   - Find **"Use Google services for push messaging"**
   - Toggle it **ON**

2. **Restart Brave browser** completely (close all windows)

3. **Try subscribing again:**
   - Go to Configuration → Notifications
   - Click "Enable Notifications"
   - Click "Subscribe to Notifications"

**Alternative:** If you don't want to enable Google services in Brave, you can:
- Use **Apprise notifications** instead (supports Discord, Slack, Telegram, Email, etc.)
- Use a different browser (Chrome, Edge, or Firefox have more reliable push support)
- Install MeshMonitor as a PWA on mobile devices

**Note:** Apprise notifications don't require browser push services and work independently of your browser choice.

---

### I'm not receiving notifications on my iPhone

**Problem:** You've enabled Web Push notifications but aren't receiving them on your iPhone (Safari or Chrome).

**Cause:** iOS is extremely strict about push notification validation. If the VAPID contact email is not set to a legitimate email address, iOS will reject push notifications as potential spam.

**Solution:**

1. **Set a valid VAPID contact email:**
   - Go to **Configuration → Notifications**
   - Scroll to the **Web Push Configuration** section
   - Find the **VAPID Contact Email** field
   - Enter a **legitimate email address** (e.g., `admin@yourdomain.com` or your real email)
   - Click **Save**

2. **Re-subscribe to notifications:**
   - Scroll to the **Notification Subscription** section
   - Click **Unsubscribe** (if already subscribed)
   - Click **Subscribe to Notifications** again
   - Grant permission when prompted

**Why this matters:**
- VAPID (Voluntary Application Server Identification) requires a contact email for accountability
- iOS validates this email and rejects notifications if it appears invalid
- Android is more lenient and may work even with invalid emails like `mailto:admin@meshmonitor.local`
- For iOS, use a real email address like `admin@yourdomain.com` or your personal email

**Valid email examples:**
- ✅ `admin@yourdomain.com`
- ✅ `your.name@gmail.com`
- ✅ `notifications@example.org`
- ❌ `mailto:admin@meshmonitor.local` (rejected by iOS)
- ❌ `admin@localhost` (rejected by iOS)
- ❌ `test@test.com` (may be rejected by iOS)

**Additional iOS considerations:**
- Ensure MeshMonitor is installed as a PWA (Progressive Web App) on your iPhone for best notification support
- Make sure "Allow Notifications" is enabled in iOS Settings for Safari/Chrome
- Test notifications by sending a test message - the notification should arrive within seconds

**Alternative for iOS users:**
If Web Push continues to be unreliable, use **Apprise notifications** instead:
- Supports services like Discord, Slack, Telegram, Pushover, and Email
- More reliable on iOS than browser-based push notifications
- Doesn't depend on browser permission or VAPID validation

---

## Performance & Troubleshooting

### MeshMonitor is running slowly

**Common causes:**

1. **Large message database:**
   - Turn on [Database Maintenance](/features/settings#database-maintenance) under **Settings → Database Maintenance**. It is off by default; once on, it deletes old data each night and then runs `VACUUM`.

2. **Low server resources:**
   - Check available memory: `docker stats` (Docker) or `free -h` (Linux)
   - Consider upgrading server resources

3. **Browser performance:**
   - Close other tabs/applications
   - Try a different browser
   - Clear browser cache

---

### How do I view MeshMonitor logs?

#### For Docker Deployments:

```bash
# View recent logs
docker compose logs meshmonitor

# Follow logs in real-time
docker compose logs -f meshmonitor

# View last 100 lines
docker compose logs --tail=100 meshmonitor
```

#### For Bare Metal Deployments:

Logs are printed to stdout/stderr where you ran `npm start` or `npm run dev:full`.

**What to look for:**
- Connection status to Meshtastic node
- Authentication events
- Error messages
- Version information

---

## Advanced Configuration

### Can I run MeshMonitor on a different port?

**Yes!** Change the port mapping in docker-compose.yml:

```yaml
ports:
  - "9000:3001"  # Access on port 9000 instead of 8080
```

Don't forget to update `ALLOWED_ORIGINS` if needed:
```yaml
environment:
  - ALLOWED_ORIGINS=http://192.168.1.50:9000
```

---

### Can I run MeshMonitor in a subfolder (e.g., /meshmonitor)?

**Yes!** Set the `BASE_URL` environment variable:

```yaml
environment:
  - BASE_URL=/meshmonitor
  - MESHTASTIC_NODE_IP=192.168.1.100
```

Then configure your reverse proxy to route `/meshmonitor` to MeshMonitor. See the [Reverse Proxy guide](/configuration/reverse-proxy) for details.

---

## Getting Help

If your issue isn't covered here:

1. **Check existing documentation:**
   - [Getting Started](/getting-started)
   - [Configuration Guide](/configuration/)
   - [Production Deployment](/configuration/production)

2. **Search GitHub Issues:**
   - [github.com/yeraze/meshmonitor/issues](https://github.com/yeraze/meshmonitor/issues)

3. **Open a new issue:**
   - Provide MeshMonitor version (check UI or logs)
   - Include relevant logs
   - Describe your deployment (Docker, bare metal, reverse proxy, etc.)
   - Include docker-compose.yml (remove sensitive data!)

4. **Community help:**
   - Check the Meshtastic Discord server
   - Post in relevant Meshtastic forums

