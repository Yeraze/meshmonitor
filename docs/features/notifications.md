# Notifications

MeshMonitor supports two notification methods: **Web Push** notifications for browsers/PWAs and **Apprise** for external notification services. Choose the method that works best for your needs, or use both!

::: tip 4.0 — notifications are scoped
- **Per-user, per-source Apprise URLs** — set from **Settings → Notifications**; each user configures their own URLs for each source they subscribe to, so home-source alerts can go to your phone without spamming the warehouse-mesh Discord channel.
- **Security Digest Apprise URL** — a single admin-set URL in **Settings → Security** that fires the weak-key / duplicate-key digest, independent of any user's preferences.
:::

![Notifications](/images/features/notifications.png)

## Overview

MeshMonitor provides flexible notification options to ensure you never miss important messages:

### Web Push Notifications

Browser-based notifications using the Web Push API with VAPID authentication. Works on iOS 16.4+ (Safari), Android (Chrome/Edge/Firefox), and desktop browsers - all without requiring any Apple certificates or platform-specific configuration.

**Key Features:**
- **Cross-Platform**: Works on iOS 16.4+, Android, and desktop browsers
- **Zero Configuration**: VAPID keys auto-generate on first run
- **No Apple Certificates**: Uses standard Web Push API
- **Background Notifications**: Receive alerts even when app is closed
- **iOS-Compliant**: Proper implementation prevents subscription cancellation

### Apprise Notifications

External notification delivery via [Apprise](https://github.com/caronc/apprise), supporting 100+ notification services including Discord, Slack, Telegram, Email, Microsoft Teams, and many more.

**Key Features:**
- **100+ Services**: Discord, Slack, Telegram, Email, SMS, and more
- **Bundled Integration**: Apprise API included in MeshMonitor container
- **Flexible Delivery**: Use multiple notification services simultaneously
- **Server-Side**: Works without browser requirements
- **Persistent Configuration**: URLs stored in persistent volume

## Browser Support

| Platform | Browser | Version | Status | Notes |
|----------|---------|---------|--------|-------|
| iOS | Safari | 16.4+ | ✅ Supported | **PWA install required** |
| Android | Chrome | Latest | ✅ Supported | Works in browser or PWA |
| Android | Firefox | Latest | ✅ Supported | Works in browser or PWA |
| Android | Edge | Latest | ✅ Supported | Works in browser or PWA |
| Desktop | Chrome | Latest | ✅ Supported | |
| Desktop | Firefox | Latest | ✅ Supported | |
| Desktop | Edge | Latest | ✅ Supported | |
| Desktop | Safari | 16+ | ✅ Supported | |

## Server Requirements

### HTTPS Requirement

Push notifications **require HTTPS** in most scenarios:

| Deployment | HTTPS Required? | Notes |
|------------|----------------|-------|
| **Production (public)** | ✅ **Required** | Must use valid SSL certificate |
| **Production (internal)** | ✅ **Required** | Self-signed certificates work for internal networks |
| **Development (localhost)** | ❌ Optional | Works on `http://localhost` or `http://127.0.0.1` |
| **iOS (any)** | ✅ **Required** | iOS requires HTTPS for PWA and push notifications |

::: warning HTTPS is Critical for iOS
iOS **requires HTTPS** for push notifications, even on internal networks. Use a self-signed certificate or reverse proxy with SSL for testing on iOS devices.
:::

### SSL/TLS Certificate Options

#### 1. Let's Encrypt (Recommended for Public Deployments)

Best for internet-facing deployments:

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d meshmonitor.example.com

# Certificates auto-renew
```

**Pros**: Free, trusted by all browsers, automated renewal

**Cons**: Requires public DNS, 90-day validity

#### 2. Self-Signed Certificates (Internal Networks)

For internal/testing deployments:

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -days 365 \
  -subj "/CN=meshmonitor.local"
```

**Pros**: Free, works for internal networks, no external dependencies

**Cons**: Browser warnings, must manually trust on each device

::: tip Trusting Self-Signed Certificates
- **iOS**: Settings → General → About → Certificate Trust Settings
- **Android**: Settings → Security → Install certificate
- **Desktop**: Browser will prompt to accept certificate
:::

#### 3. Reverse Proxy with SSL Termination (Recommended)

Use NGINX, Traefik, or Caddy to handle SSL:

```nginx
server {
    listen 443 ssl http2;
    server_name meshmonitor.local;

    ssl_certificate /etc/ssl/certs/meshmonitor.crt;
    ssl_certificate_key /etc/ssl/private/meshmonitor.key;

    location / {
        proxy_pass http://meshmonitor:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

See the [Reverse Proxy guide](/configuration/reverse-proxy) for complete setup.

### VAPID Configuration

VAPID (Voluntary Application Server Identification) keys are used to authenticate push notification requests.

#### Automatic Configuration (Recommended)

MeshMonitor automatically generates and stores VAPID keys in the database on first run. **No manual configuration needed!**

#### Manual Configuration (Optional)

If you prefer to manage VAPID keys manually:

1. Generate keys:
   ```bash
   node generate-vapid-keys.js
   ```

2. Add to `.env` or docker-compose.yml:
   ```env
   VAPID_PUBLIC_KEY=your-public-key-here
   VAPID_PRIVATE_KEY=your-private-key-here
   VAPID_SUBJECT=mailto:admin@example.com
   ```

3. Restart MeshMonitor

::: info Environment Variables
The following environment variables are **optional**:
- `VAPID_PUBLIC_KEY` - VAPID public key (auto-generated if not set)
- `VAPID_PRIVATE_KEY` - VAPID private key (auto-generated if not set)
- `VAPID_SUBJECT` - Contact email starting with `mailto:` (can be set via admin UI)
:::

### Docker Configuration

For Docker deployments, ensure you have HTTPS configured via reverse proxy:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      # VAPID keys auto-generate - no configuration needed!
    volumes:
      - meshmonitor-data:/data
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/ssl/certs:ro
    depends_on:
      - meshmonitor
```

### Kubernetes Configuration

For Kubernetes, use cert-manager for automated certificate management:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: meshmonitor-tls
spec:
  secretName: meshmonitor-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - meshmonitor.example.com
```

## Client Setup

### iOS Setup (Step-by-Step)

iOS requires the app to be installed as a PWA before notifications can work:

#### Step 1: Install MeshMonitor as PWA

1. Open MeshMonitor in **Safari** (must be Safari, not Chrome or other browsers)
2. Navigate to your MeshMonitor URL (must be HTTPS)
3. Tap the **Share button** (square with arrow pointing up) at the bottom of the screen
4. Scroll down and tap **"Add to Home Screen"**
5. Tap **"Add"** in the top right corner

::: warning Only Safari Works for iOS PWA
PWA installation on iOS **only works in Safari**. Chrome, Firefox, and other browsers on iOS cannot install PWAs.
:::

#### Step 2: Open from Home Screen

1. Go to your home screen
2. Tap the **MeshMonitor icon** (don't open Safari)
3. The app should open in standalone mode (no Safari UI visible)

::: tip Verify Standalone Mode
You should NOT see the Safari address bar or navigation buttons. If you do, you're not in PWA mode and notifications won't work.
:::

#### Step 3: Enable Notifications

1. In MeshMonitor, navigate to **Configuration → Notifications** (in the sidebar)
2. Verify all checkmarks are green under "Browser Support"
3. Ensure "PWA Installed" shows ✅ Yes
4. Click **"🔔 Enable Notifications"**
5. When prompted, tap **"Allow"** to grant notification permission
6. The app will automatically subscribe you to notifications
7. You should see "✅ You are subscribed to push notifications!"

#### Step 4: Test Notifications (Optional)

1. Have another user send a message on the mesh
2. You should receive a notification even with the app closed
3. Tap the notification to open MeshMonitor to that message

::: warning iOS Notification Permissions
If you deny permission, you must go to **iOS Settings → MeshMonitor → Notifications** to re-enable it. The app cannot re-request permission after denial.
:::

### Android Setup (Step-by-Step)

Android supports notifications both in the browser and as a PWA:

#### Option 1: Browser Notifications (Chrome/Edge/Firefox)

1. Open MeshMonitor in your browser (HTTP or HTTPS both work for localhost)
2. Navigate to **Configuration → Notifications**
3. Click **"🔔 Enable Notifications"**
4. When prompted, tap **"Allow"** to grant notification permission
5. The app will automatically subscribe you
6. You should see "✅ You are subscribed to push notifications!"

#### Option 2: PWA Installation (Recommended)

1. Open MeshMonitor in Chrome/Edge
2. Tap the **⋮ menu** (three dots in top right)
3. Tap **"Install app"** or **"Add to Home screen"**
4. Tap **"Install"**
5. Open the app from your home screen
6. Follow the "Browser Notifications" steps above

::: tip PWA Benefits on Android
Installing as PWA provides:
- Standalone app experience
- Faster loading (offline support)
- Better notification reliability
- No browser address bar
:::

#### Testing Notifications

1. Have another user send a message
2. Lock your screen or switch to another app
3. You should receive a notification
4. Tap notification to open MeshMonitor

### Desktop Setup (Step-by-Step)

Desktop browsers support notifications without PWA installation:

#### Chrome/Edge/Brave

1. Open MeshMonitor in your browser
2. Navigate to **Configuration → Notifications**
3. Click **"🔔 Enable Notifications"**
4. When prompted, click **"Allow"** in the browser popup
5. The app will automatically subscribe you
6. You should see "✅ You are subscribed to push notifications!"

#### Firefox

1. Open MeshMonitor in Firefox
2. Navigate to **Configuration → Notifications**
3. Click **"🔔 Enable Notifications"**
4. Click **"Allow"** in the Firefox permission popup
5. The app will automatically subscribe you
6. You should see "✅ You are subscribed to push notifications!"

#### Safari (macOS)

1. Open MeshMonitor in Safari 16+
2. Navigate to **Configuration → Notifications**
3. Click **"🔔 Enable Notifications"**
4. Click **"Allow"** when Safari prompts for permission
5. You'll be automatically subscribed

::: tip Desktop Notifications
Desktop notifications work even when the browser is minimized or in the background. The browser does NOT need to be in focus.
:::

## Administrator Configuration

### Updating VAPID Contact Email

The VAPID subject (contact email) is sent with each push notification request:

1. Go to **Configuration → Notifications** (admin only)
2. Scroll to "VAPID Configuration"
3. Update the "Contact Email" field (must start with `mailto:`)
4. Click **"Update Contact Email"**

Example: `mailto:admin@example.com`

### Viewing Subscription Status

Admins can see:
- **VAPID Status**: Whether keys are configured
- **Active Subscriptions**: Number of users subscribed to notifications
- **Public Key**: First 50 characters of the VAPID public key

### Testing Notifications

Admins can send test notifications:

1. Go to **Configuration → Notifications**
2. Scroll to "Test Notifications" section
3. Click **"🧪 Send Test Notification"**
4. All subscribed users (including yourself) will receive a test notification

::: warning Test Sends to ALL Users
The test notification is sent to ALL subscribed users, not just the admin. Use sparingly!
:::

## Apprise Notifications Setup

Apprise allows you to send notifications to 100+ external services including Discord, Slack, Telegram, Email, and more.

### What is Apprise?

[Apprise](https://github.com/caronc/apprise) is a universal notification library that supports a vast array of notification services through a simple URL-based configuration. MeshMonitor bundles Apprise directly in the Docker container for easy setup.

### Supported Services

Apprise supports 100+ notification services including:

- **Chat & Messaging**: Discord, Slack, Microsoft Teams, Telegram, Matrix, Rocket.Chat
- **Email**: SMTP, Gmail, SendGrid, Mailgun, Amazon SES
- **SMS**: Twilio, MessageBird, Nexmo, Clickatell
- **Push Notifications**: Pushover, Pushbullet, Pushsafer, Notify
- **Social Media**: Twitter/X
- **Development Tools**: GitHub, GitLab, JIRA
- **Home Automation**: Home Assistant, MQTT
- **And many more...**

See the [full list of supported services](https://github.com/caronc/apprise#supported-notifications) in the Apprise documentation.

### Enabling Apprise

1. Navigate to **Configuration → Notifications** in MeshMonitor
2. In the **Notification Services** section at the top, toggle **"Apprise Notifications"** to enabled (green border)
3. Click **"Save Notification Settings"**
4. The **Apprise Configuration** section will appear below

### Configuring Notification URLs

Apprise uses URL-based configuration. Each service has a unique URL format:

#### Discord Example

```
discord://webhook_id/webhook_token
```

To get your Discord webhook URL:
1. In Discord, go to Server Settings → Integrations → Webhooks
2. Create a new webhook or edit an existing one
3. Copy the webhook URL (e.g., `https://discord.com/api/webhooks/123456789/abcdefg...`)
4. Convert to Apprise format: `discord://123456789/abcdefg...`

#### Slack Example

```
slack://token_a/token_b/token_c
```

#### Email Example

```
mailto://user:password@gmail.com
```

For Gmail, you'll need to use an [App Password](https://support.google.com/accounts/answer/185833):
```
mailto://your-email@gmail.com:app-password@gmail.com
```

#### Telegram Example

```
tgram://bot_token/chat_id
```

#### Microsoft Teams Example

```
msteams://token_a/token_b/token_c
```

### Adding Multiple Services

You can configure multiple notification services simultaneously. Simply add one URL per line in the Apprise Configuration textarea:

```
discord://webhook_id/webhook_token
slack://token_a/token_b/token_c
mailto://user:password@gmail.com
tgram://bot_token/chat_id
```

All configured services will receive notifications for new messages.

### Testing Apprise Notifications

After configuring your URLs:

1. Click **"Save Configuration"** to save your Apprise URLs
2. Click **"Test Connection"** to verify the configuration works
3. You should receive test notifications on all configured services
4. Send a test message in MeshMonitor to verify real notifications work

### URL Format Reference

Each service has a specific URL format. Here are some common examples:

| Service | URL Format | Notes |
|---------|-----------|-------|
| Discord | `discord://webhook_id/webhook_token` | Get from Server Settings → Webhooks |
| Slack | `slack://token_a/token_b/token_c` | From Slack app configuration |
| Email (SMTP) | `mailto://user:pass@smtp.example.com` | Standard SMTP configuration |
| Gmail | `mailto://user:app-password@gmail.com` | Requires App Password |
| Telegram | `tgram://bot_token/chat_id` | Get from BotFather |
| Pushover | `pover://user_key@token` | From Pushover account |
| Microsoft Teams | `msteams://token_a/token_b/token_c` | From Teams webhook |

For complete URL format documentation for all services, see the [Apprise Wiki](https://github.com/caronc/apprise/wiki).

### Persistent Configuration

Apprise URLs are stored in `/data/apprise-config/urls.txt` inside the Docker container, which is mapped to the persistent `/data` volume. This means your Apprise configuration will survive:

- Container restarts
- Container upgrades
- System reboots

### Security Considerations

::: warning Protect Your Notification URLs
Apprise URLs contain authentication tokens that allow sending notifications to your services. Keep these URLs secure:

- Don't commit them to version control
- Restrict access to the Notifications configuration page (admin only)
- Rotate tokens if compromised
- Use read-only or limited-permission tokens when possible
:::

### Troubleshooting Apprise

#### URLs Not Saving

- Check that you clicked **"Save Configuration"** after entering URLs
- Verify the `/data` volume is writable
- Check Docker logs for errors: `docker logs meshmonitor`

#### Notifications Not Receiving

1. Verify Apprise is enabled in Notification Services section
2. Click **"Test Connection"** to verify URLs are correct
3. Check Docker logs for error messages:
   ```bash
   docker logs meshmonitor | grep -i apprise
   ```
4. Verify the URL format matches the service requirements
5. Check that tokens/credentials are still valid

#### Connection Test Fails

- Verify the URL format is correct for your service
- Check that authentication tokens are valid and not expired
- Ensure the container has network access to the notification service
- For Discord/Slack, verify the webhook still exists

## Muting Channels and DMs

You can silence notifications for a specific channel or direct message conversation without disabling notifications globally. Mutes are stored on the server and apply across all your devices and browsers.

### Muting a Channel

1. Open the **Channels** tab
2. Click the 🔔 icon next to the channel name in the channel header
3. Select a mute duration from the dropdown:
   - **Mute indefinitely** — stays muted until you unmute it
   - **Mute for 1 hour** — automatically expires after 60 minutes
   - **Mute for 1 week** — automatically expires after 7 days
4. The channel icon changes to 🔇 in both the header and the sidebar

### Muting a DM Conversation

1. Open a direct message thread
2. Click the **Actions ▼** menu at the top of the conversation
3. Select a mute option (indefinitely, 1 hour, or 1 week)
4. The DM entry in the sidebar shows a 🔇 indicator while muted

### Unmuting

- **Channel**: Click the 🔇 icon in the channel header and select **Unmute**
- **DM**: Open the **Actions ▼** menu and select **Unmute**

### What Muting Affects

Muting a channel or DM suppresses:
- Browser audio notification sounds
- Web Push notifications sent to your browser/device
- Apprise notifications (Discord, Slack, email, etc.) delivered by the server

::: tip Whitelist Overrides Mutes
If a message contains a keyword on your notification **whitelist**, it will still trigger a notification even if the channel is muted. Use the whitelist for high-priority terms (like your call sign) that should always break through.
:::

::: info Mute Expiry
Time-based mutes expire automatically — no server-side job runs. Expiry is checked at the moment each notification is evaluated, so a mute that expires while you are away is correctly lifted the next time a message arrives.
:::

### Cross-Device Sync

Mute preferences are stored in your user account on the MeshMonitor server (in `user_notification_preferences`). They apply regardless of which browser or device you use to access MeshMonitor.

## Notification Settings

### Notification Services

Users can enable or disable notification services independently:

- **Web Push Notifications**: Browser/PWA-based notifications
- **Apprise Notifications**: External notification services (Discord, Slack, etc.)

Both services can be enabled simultaneously, and they share the same filtering preferences.

### Filtering Preferences

Notification filtering applies to **both Web Push and Apprise** notifications:

- **Whitelist**: Keywords that always trigger notifications (highest priority)
- **Blacklist**: Keywords that never trigger notifications (second priority)
- **Emoji Reactions**: Enable/disable notifications for emoji-only messages (third priority)
- **Newly Found Nodes**: Enable/disable notifications when new nodes are discovered
- **Successful Traceroutes**: Enable/disable notifications for completed traceroute responses
- **Enabled Channels**: Specific channels to receive notifications from
- **Direct Messages**: Enable/disable direct message notifications

The filtering follows this priority order for **message notifications**:
1. **Whitelist** → Always send notification if keyword matches
2. **Blacklist** → Never send notification if keyword matches
3. **Emoji Reactions** → Filter emoji-only messages if disabled
4. **Channel/DM Settings** → Send only if channel is enabled or DM is enabled

**Special Event Notifications** (bypass message filtering):
- **Newly Found Nodes** → Sent when a new node appears on the mesh (includes node name and hop count)
- **Successful Traceroutes** → Sent when a traceroute completes (includes full forward and return route)

::: tip Emoji Reaction Filtering
When "Emoji Reactions" is disabled, notifications will be suppressed for messages containing only emojis (e.g., "👍", "😀", "❤️"). Messages with emojis mixed with text will still trigger notifications normally. This is useful for reducing notification noise from emoji reactions and tapbacks.
:::

::: info Special Event Notifications
New Node and Traceroute notifications bypass normal message filtering (whitelist/blacklist/channel settings) and are only sent if you have that specific preference enabled. These notifications help you stay informed about mesh network topology changes and connectivity testing without cluttering your message notifications.
:::

### Client-Side Settings (Web Push Only)

For Web Push notifications specifically:

- **Enable/Disable**: Grant or revoke browser permission
- **Subscribe/Unsubscribe**: Opt-in or opt-out of receiving notifications
- **Per-Device**: Each device (phone, tablet, desktop) requires separate subscription

::: info Browser Permissions
Notification permissions are controlled by the browser. If denied, you must reset permissions in browser settings:
- **Chrome**: Click lock icon → Site settings → Notifications
- **Safari**: Safari → Settings → Websites → Notifications
- **Firefox**: Click lock icon → Permissions → Notifications
:::

### Server-Side Settings

**Web Push:**
- No configuration required - VAPID keys auto-generate on first run
- Optional: Update VAPID Contact Email via admin UI
- Optional: Set manual VAPID keys via environment variables

**Apprise:**
- Bundled Apprise API runs automatically in Docker container
- Configuration stored in persistent `/data/apprise-config/` directory
- No environment variables required

## Troubleshooting

### Notifications Not Working

#### Check Browser Support

1. Go to **Configuration → Notifications**
2. Verify all checkmarks under "Browser Support" are green:
   - ✅ Notifications API: Supported
   - ✅ Service Workers: Supported
   - ✅ Push API: Supported
   - ✅ Permission: Granted
   - ✅ Subscription: Subscribed

#### iOS-Specific Issues

**Problem**: "PWA Installed" shows ⚠️ No

**Solution**:
1. Ensure you opened MeshMonitor in **Safari** (not Chrome)
2. Add to Home Screen via Safari's Share button
3. Open from the **home screen icon** (not Safari)

**Problem**: Notifications not appearing

**Solution**:
1. Go to iOS **Settings → MeshMonitor → Notifications**
2. Ensure "Allow Notifications" is ON
3. Check notification settings (Lock Screen, Banner, etc.)

**Problem**: "Subscription Cancelled" message

**Solution**:
- This shouldn't happen with MeshMonitor's iOS-compliant implementation
- If it does, unsubscribe and re-subscribe in app
- Check browser console for errors

#### Android-Specific Issues

**Problem**: Permission denied

**Solution**:
1. Go to **Android Settings → Apps → [Browser] → Notifications**
2. Enable notifications for the browser
3. Return to MeshMonitor and try again

**Problem**: Not receiving notifications

**Solution**:
1. Ensure browser is allowed to run in background
2. Disable battery optimization for browser:
   - **Settings → Battery → Battery optimization**
   - Find browser, set to "Don't optimize"

#### Desktop-Specific Issues

**Problem**: Permission denied

**Solution**:
- **Chrome**: `chrome://settings/content/notifications`
- **Firefox**: Options → Privacy & Security → Permissions → Notifications
- **Safari**: Safari → Settings → Websites → Notifications
- Find MeshMonitor URL and set to "Allow"

**Problem**: Notifications not appearing when browser is closed

**Solution**:
- Most desktop browsers require the browser to be running (can be minimized)
- On Windows/Linux, check system notification settings
- On macOS, check System Settings → Notifications

### HTTPS/SSL Issues

**Problem**: "PWA cannot be installed" on iOS

**Solution**:
- iOS requires HTTPS for PWA installation
- Use valid SSL certificate or self-signed certificate
- Trust the certificate in iOS settings if self-signed

**Problem**: Mixed content warnings

**Solution**:
- Ensure ALL resources load over HTTPS
- Check browser console for specific HTTP resource URLs
- Update any hard-coded HTTP URLs to HTTPS

### VAPID Configuration Issues

**Problem**: "VAPID public key not available"

**Solution**:
1. Check server logs for VAPID key generation errors
2. Ensure database is writable
3. Restart MeshMonitor to trigger auto-generation
4. Alternatively, manually set VAPID keys via environment variables

**Problem**: Push notifications fail to send

**Solution**:
1. Check server logs for push notification errors
2. Verify VAPID keys are configured correctly
3. Ensure subscription endpoint is valid
4. Check network connectivity from server to push service

## How It Works

### Architecture Overview

```
┌─────────────┐          ┌──────────────┐          ┌─────────────┐
│   Browser   │          │  MeshMonitor │          │ Push Service│
│             │          │    Server    │          │ (Browser)   │
└─────────────┘          └──────────────┘          └─────────────┘
       │                         │                         │
       │  1. Request Permission  │                         │
       │────────────────────────>│                         │
       │                         │                         │
       │  2. Subscribe with VAPID│                         │
       │────────────────────────>│                         │
       │                         │                         │
       │  3. Store Subscription  │                         │
       │                         │──┐                      │
       │                         │  │ Database             │
       │                         │<─┘                      │
       │                         │                         │
       │                         │  4. New Message Arrives │
       │                         │──┐                      │
       │                         │<─┘                      │
       │                         │                         │
       │                         │  5. Send Push           │
       │                         │────────────────────────>│
       │                         │                         │
       │  6. Receive Notification│                         │
       │<──────────────────────────────────────────────────│
       │                         │                         │
       │  7. Click Notification  │                         │
       │─────────────────────────────────────────>        │
       │         (Opens/Focuses App)                       │
```

### Subscription Flow

1. **User clicks "Enable Notifications"**
2. **Browser requests permission** from user
3. **User grants permission**
4. **Frontend subscribes with PushManager** using VAPID public key
5. **Browser generates subscription** (endpoint + keys)
6. **Frontend sends subscription to backend API**
7. **Backend stores subscription** in database
8. **User receives push notifications** for new messages

### Notification Flow

1. **New message arrives** on Meshtastic node
2. **Backend processes and stores message**
3. **Backend sends push via Web Push API** to browser's push service
4. **Push service routes to user's browser**
5. **Service Worker receives push event** (even if app closed)
6. **Service Worker shows notification** to user
7. **User sees notification** on lock screen/notification center

### iOS-Specific Handling

iOS Safari has strict requirements to prevent abuse:

- **event.waitUntil()**: Must be used to keep service worker alive
- **Silent push detection**: Sending 3+ silent pushes cancels subscription
- **PWA requirement**: Only works when installed to home screen
- **User interaction**: Permission must be requested via user action

MeshMonitor handles all of these requirements automatically with iOS-compliant service worker implementation.

## Security & Privacy

### VAPID Authentication

- All push requests are authenticated with VAPID keys
- Push services verify the request came from your server
- Prevents unauthorized parties from sending notifications

### User Control

- Users must explicitly grant permission
- Users must explicitly subscribe
- Users can unsubscribe at any time
- Each device requires separate subscription

### Endpoint Security

- Subscription endpoints are unique per user/device
- Endpoints are stored securely in database
- Expired subscriptions are automatically cleaned up

### Privacy

- Push payload only contains message preview (not full message)
- No personal data stored in push subscription
- User can revoke permission at any time in browser settings

## API Reference

### Subscribe to Push Notifications

```http
POST /api/push/subscribe
Content-Type: application/json

{
  "subscription": {
    "endpoint": "https://push.service.com/...",
    "keys": {
      "p256dh": "base64-encoded-key",
      "auth": "base64-encoded-key"
    }
  }
}
```

### Unsubscribe from Push Notifications

```http
POST /api/push/unsubscribe
Content-Type: application/json

{
  "endpoint": "https://push.service.com/..."
}
```

### Get VAPID Public Key

```http
GET /api/push/vapid-key

Response:
{
  "publicKey": "BFz...",
  "status": {
    "configured": true,
    "subscriptionCount": 5
  }
}
```

### Send Test Notification (Admin Only)

```http
POST /api/push/test
Content-Type: application/json

{}

Response:
{
  "sent": 5,
  "failed": 0
}
```

### Update VAPID Subject (Admin Only)

```http
PUT /api/push/vapid-subject
Content-Type: application/json

{
  "subject": "mailto:admin@example.com"
}
```

### Get VAPID Status (Admin Only)

```http
GET /api/push/status

Response:
{
  "status": {
    "configured": true,
    "publicKey": "BFz...",
    "subject": "mailto:admin@example.com",
    "subscriptionCount": 5
  }
}
```

## Related Documentation

- [Reverse Proxy Configuration](/configuration/reverse-proxy) - Set up HTTPS with NGINX/Traefik/Caddy
- [HTTP vs HTTPS](/configuration/http-vs-https) - Understanding SSL/TLS certificates
- [Production Deployment](/configuration/production) - Best practices for production
- [Settings](/features/settings) - Configure MeshMonitor behavior

## References

- [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [VAPID for Web Push](https://datatracker.ietf.org/doc/html/rfc8292)
- [iOS PWA Push Notifications](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
