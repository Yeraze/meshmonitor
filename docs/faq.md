# Frequently Asked Questions (FAQ)

This page covers common issues and questions from MeshMonitor users. For developer-specific questions, see the [Development Documentation](/development/).

## 🚨 Common Issues

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

**Note:** `http://localhost` works by default and doesn't need to be added.

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

**Cause:** This is a **cookie security** issue. MeshMonitor can't set session cookies due to security settings.

**Solution:** The fix depends on your deployment:

#### Scenario A: Behind HTTPS Reverse Proxy (Recommended)

If you're using nginx, Caddy, or Traefik with HTTPS:

```yaml
environment:
  - NODE_ENV=production
  - TRUST_PROXY=true              # Required!
  - SESSION_SECRET=your-secret-here
  - ALLOWED_ORIGINS=https://meshmonitor.example.com
```

**Why:** When a reverse proxy terminates HTTPS, MeshMonitor sees the connection as HTTP. Setting `TRUST_PROXY=true` tells MeshMonitor to trust the `X-Forwarded-Proto` header from your proxy.

#### Scenario B: Direct HTTP Access (Development/Testing Only)

If you're accessing MeshMonitor directly over HTTP (no reverse proxy):

```yaml
environment:
  - NODE_ENV=production
  - COOKIE_SECURE=false          # Only for HTTP!
  - SESSION_SECRET=your-secret-here
```

**⚠️ Warning:** This reduces security. Use HTTPS for production deployments.

#### Scenario C: Direct HTTPS Access

If MeshMonitor itself handles HTTPS (with TLS certificates):

```yaml
environment:
  - NODE_ENV=production
  - SESSION_SECRET=your-secret-here
```

**How to diagnose:**
1. Open browser Developer Tools (F12)
2. Go to Application tab → Cookies
3. Check if `meshmonitor.sid` cookie exists after login
4. If missing, it's a cookie security issue
5. Check Docker logs for warnings about SESSION_SECRET or COOKIE_SECURE

**After fixing:**
```bash
docker compose down
docker compose up -d
```

---

### Emoji appear as blank squares in offline/air-gapped deployments

**Problem:** Icons in the sidebar and throughout the UI appear as blank white squares (☐) instead of emoji like 🗺️ 💬 ✉️.

**Cause:** MeshMonitor uses native **Unicode emoji** which are rendered by your operating system's emoji font. In offline or air-gapped environments, the system may not have an emoji font installed.

**Solution:** Install an emoji font on the system running the browser (or the Docker host if using a local browser):

| Operating System | Command |
|-----------------|---------|
| **Debian/Ubuntu** | `sudo apt install fonts-noto-color-emoji` |
| **Fedora/RHEL** | `sudo dnf install google-noto-emoji-color-fonts` |
| **Arch Linux** | `sudo pacman -S noto-fonts-emoji` |
| **Alpine Linux** | `apk add font-noto-emoji` |
| **Windows** | Segoe UI Emoji (included by default) |
| **macOS** | Apple Color Emoji (included by default) |

**After installing:**

1. Refresh the font cache (Linux only):
   ```bash
   fc-cache -fv
   ```

2. Restart your browser

3. Reload MeshMonitor

**Note:** This is a client-side issue - the emoji font needs to be installed on the machine running the web browser, not necessarily on the MeshMonitor server (unless they're the same machine).

---

## 📡 Node Management

### Can I monitor multiple Meshtastic nodes with one MeshMonitor instance?

**No.** Each MeshMonitor instance connects to exactly **one** Meshtastic node at a time.

**Why:** MeshMonitor maintains a persistent TCP connection to a single node and stores all mesh data from that node's perspective.

**Solution for multiple nodes:**

Run multiple MeshMonitor instances, one per node:

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
    restart: unless-stopped

  meshmonitor-node2:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor-node2
    ports:
      - "8081:3001"  # Different port!
    volumes:
      - meshmonitor-node2-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.101
      - ALLOWED_ORIGINS=http://192.168.1.50:8081
    restart: unless-stopped

volumes:
  meshmonitor-node1-data:
  meshmonitor-node2-data:
```

Access them at:
- Node 1: `http://192.168.1.50:8080`
- Node 2: `http://192.168.1.50:8081`

---

### I get CSRF errors when running multiple MeshMonitor instances on the same host

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

## 🔐 User Management

### How do I reset a user's password as an admin?

1. **Login as admin** (or any user with admin permissions)

2. **Navigate to User Management:**
   - Click your username in the top right corner
   - Select "Admin Panel" from the dropdown
   - Click "User Management"

3. **Find the user:**
   - Locate the user in the user list
   - Click the "Reset Password" button next to their name

4. **Set new password:**
   - Enter a temporary password
   - Click "Save"
   - Provide this temporary password to the user
   - Instruct them to change it immediately after login

**Note:** Admin users can reset passwords for any user except other admins (unless you're a super admin).

---

### I forgot the admin password - how do I reset it?

**Problem:** You've lost access to the admin account and can't login.

**Solution:** Use the built-in password reset script to reset the admin password without losing any data. The script automatically detects your database backend (SQLite, PostgreSQL, or MySQL) and uses the correct driver.

#### For Docker Deployments (SQLite — default):

```bash
docker compose exec meshmonitor node reset-admin.mjs
```

#### For Docker Deployments (PostgreSQL or MySQL):

The script reads `DATABASE_URL` from the container environment, so it works automatically:

```bash
docker compose exec meshmonitor node reset-admin.mjs
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

**⚠️ Warning:** This deletes ALL data including messages, nodes, user accounts, and settings. Only do this as a last resort.

#### For Docker Deployments:

```bash
# Stop MeshMonitor
docker compose down

# Remove the data volume (this deletes ALL data!)
docker volume rm meshmonitor-meshmonitor-data

# Or if you named your volume differently:
docker volume ls  # Find your volume name
docker volume rm <your-volume-name>

# Start MeshMonitor
docker compose up -d
```

#### For Bare Metal Deployments:

```bash
# Stop MeshMonitor
# (use Ctrl+C or your process manager)

# Delete the database
rm -f data/meshmonitor.db

# Start MeshMonitor
npm start
```

**After wiping:**
- MeshMonitor will create a new database
- Default admin account will be recreated:
  - Username: `admin`
  - Password: `changeme`

---

## 🔄 Updates & Maintenance

### How do I update MeshMonitor to the latest version?

#### For Docker Deployments:

```bash
# Pull the latest image
docker compose pull

# Restart with new image
docker compose down
docker compose up -d

# Verify version
docker compose logs meshmonitor | grep "Version:"
```

---

### I get "container name is already in use" error after auto-upgrade

**Problem:** After using the built-in auto-upgrade feature, manual `docker compose pull && docker compose up` commands fail with:

```
Error response from daemon: Conflict. The container name "/meshmonitor" is already in use by container "xxxxx".
You have to remove (or rename) that container to be able to reuse that name.
```

**Cause:** This happens when the auto-upgrade watchdog successfully upgraded your container, but the container wasn't properly managed by Docker Compose afterward.

**Solution:** Remove the existing container and recreate it with Docker Compose:

```bash
# Stop and remove the existing container
docker stop meshmonitor
docker rm meshmonitor

# Restart using Docker Compose (this properly manages the container)
docker compose up -d

# Verify it's running
docker compose ps
```

**Prevention:** This issue is fixed in MeshMonitor v2.18.5 and later. The upgrade watchdog now uses Docker Compose to recreate containers, ensuring compatibility with manual `docker compose` commands.

**How it works:**
- **Before v2.18.5:** The watchdog used `docker run` commands, creating containers outside Docker Compose management
- **After v2.18.5:** The watchdog uses `docker compose up -d --force-recreate`, maintaining Docker Compose compatibility

**If you see this frequently:** Upgrade to the latest version of MeshMonitor to get the improved upgrade process.

#### For Bare Metal Deployments:

```bash
# Stop MeshMonitor
# (use Ctrl+C or your process manager)

# Pull latest code
git pull origin main

# Update dependencies
npm install

# Rebuild
npm run build
npm run build:server

# Start MeshMonitor
npm start
```

**Check for updates:** MeshMonitor displays a banner when a new version is available (requires internet connection).

---

### How do I back up my MeshMonitor data?

#### For Docker Deployments:

```bash
# Create backup directory
mkdir -p ~/meshmonitor-backups

# Backup the volume
docker run --rm \
  -v meshmonitor-meshmonitor-data:/data \
  -v ~/meshmonitor-backups:/backup \
  alpine tar czf /backup/meshmonitor-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restore from backup (if needed)
docker run --rm \
  -v meshmonitor-meshmonitor-data:/data \
  -v ~/meshmonitor-backups:/backup \
  alpine tar xzf /backup/meshmonitor-backup-YYYYMMDD.tar.gz -C /data
```

#### For Bare Metal Deployments:

```bash
# The database is in the data directory
cp data/meshmonitor.db ~/meshmonitor-backup-$(date +%Y%m%d).db
```

**What's backed up:**
- SQLite database (messages, nodes, users, settings)
- Session data
- All configuration stored in the database

**What's NOT backed up:**
- Environment variables (docker-compose.yml)
- Application code
- Docker images

---

## 🌐 Network & Connectivity

### MeshMonitor can't connect to my Meshtastic node

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

See the [BLE Bridge repository](https://github.com/Yeraze/meshtastic-ble-bridge) for detailed setup instructions.

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

## 🎨 Interface & Features

### What do the icons in the Node List mean?

When viewing nodes in the **Nodes** tab, you'll see various icons next to each node that indicate different statuses and capabilities:

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

---

### The map doesn't show any nodes

**Possible causes:**

1. **Nodes don't have GPS coordinates:**
   - Check if nodes have reported position data
   - Go to Nodes tab to see which nodes have coordinates
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

**Cause:** Node visibility in MeshMonitor is controlled by **channel permissions**. Each node is associated with the channel it was last heard on, and users (including anonymous users) can only see nodes on channels they have the appropriate permissions for. By default, anonymous users have no channel permissions.

**Solution:** Configure channel permissions for the anonymous user:

1. **Login as admin**

2. **Navigate to User Management:**
   - Go to **Settings > Users**
   - Or click your username in the top right corner and select "Settings"

3. **Find the anonymous user:**
   - Look for the user named **"anonymous"** in the user list
   - Click on it to edit permissions

4. **Grant channel permissions:**
   - In the permissions section, find the channel permissions (e.g., `channel_0`, `channel_1`, etc.)
   - Enable **View Map** permission for each channel you want anonymous users to see on the map
   - Optionally enable **Read** permission if you also want them to see messages
   - Click **Save**

See [Understanding Channel Permissions](#understanding-channel-permissions) below for more details on the permission types.

---

### Understanding Channel Permissions

As of **v3.1.0**, MeshMonitor uses a **tri-state permission system** for channels, giving administrators fine-grained control over what users can see and do:

| Permission | Description |
|------------|-------------|
| **View Map** | User can see node positions on the map for nodes heard on this channel |
| **Read** | User can read messages from this channel (in the Messages tab) |
| **Write** | User can send messages to this channel (implies Read access) |

**How permissions work:**

- Each node is associated with the channel it was last heard on
- **View Map** controls whether nodes appear on the map - this is the most common permission needed for public dashboards
- **Read** controls access to the Messages tab for that channel
- **Write** allows sending messages and automatically includes Read access

**Example configurations:**

| Use Case | View Map | Read | Write |
|----------|----------|------|-------|
| Public map-only dashboard | ✅ | ❌ | ❌ |
| Read-only access (map + messages) | ✅ | ✅ | ❌ |
| Full access | ✅ | ✅ | ✅ |
| Hidden channel (logged-in users only) | ❌ | ❌ | ❌ |

**Configuring the Anonymous user:**

The **anonymous** user controls what unauthenticated visitors can see. Common setups:

- **Public dashboard:** Enable `View Map` on `channel_0` (primary channel) for anonymous
- **Private network:** Leave all permissions disabled - visitors must log in
- **Selective exposure:** Enable `View Map` only on specific public channels

**Important notes:**

- Changes take effect immediately - no restart required
- API token users follow the same permission filtering based on their associated user account
- The V1 API respects these permissions for all node and message queries

---

### How do I send messages to a specific channel?

1. **Go to Messages tab**

2. **Select channel from dropdown:**
   - Click the channel selector at the top
   - Choose your target channel (e.g., "LongFast", "Private")

3. **Type and send:**
   - Type your message
   - Click Send or press Enter

**Note:** You can only send to channels configured on your connected node.

---

## 🔔 Notifications

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

## 📊 Performance & Troubleshooting

### MeshMonitor is running slowly

**Common causes:**

1. **Large message database:**
   - Go to Settings → Database
   - Use "Cleanup Old Messages" to remove old data
   - Consider setting up automatic cleanup

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

## 🔧 Advanced Configuration

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

## 🆘 Getting Help

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

---

**Last updated:** 2026-02-03
