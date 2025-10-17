# Push Notifications for MeshMonitor

MeshMonitor now supports PWA push notifications on both iOS and Android! This feature allows users to receive real-time notifications for new messages even when the app is in the background or closed.

## Features

- **Cross-Platform**: Works on iOS 16.4+ (Safari) and Android (Chrome/Edge/Firefox)
- **Zero Configuration**: VAPID keys auto-generate on first run
- **No Apple Certificates**: Uses standard Web Push API with VAPID authentication
- **Background Notifications**: Receive alerts even when app is closed
- **iOS-Compliant**: Proper implementation prevents subscription cancellation
- **Smart Filtering**: Only sends notifications for messages from other users

## Browser Support

| Platform | Browser | Version | Status |
|----------|---------|---------|--------|
| iOS | Safari | 16.4+ | ✅ Supported (PWA install required) |
| Android | Chrome | Latest | ✅ Supported |
| Android | Firefox | Latest | ✅ Supported |
| Android | Edge | Latest | ✅ Supported |
| Desktop | Chrome | Latest | ✅ Supported |
| Desktop | Firefox | Latest | ✅ Supported |
| Desktop | Edge | Latest | ✅ Supported |
| Desktop | Safari | 16+ | ✅ Supported |

## iOS Requirements

On iOS, push notifications **only work when MeshMonitor is installed as a PWA**:

1. Open MeshMonitor in Safari
2. Tap the Share button (square with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Open MeshMonitor from your home screen
5. Go to **Configuration → Notifications**
6. Click "Enable Notifications"

## Setup for Users

### 1. Enable Notifications

1. Navigate to **Configuration → Notifications** in the sidebar
2. Click **"🔔 Enable Notifications"**
3. Grant permission when prompted by your browser
4. Click **"📥 Subscribe to Notifications"**
5. You'll see "✅ You are subscribed to push notifications!"

### 2. Test Notifications (Admin Only)

Administrators can test the notification system:

1. Go to **Configuration → Notifications**
2. Scroll to "Test Notifications" section
3. Click **"🧪 Send Test Notification"**
4. You should receive a test notification

## Setup for Administrators

### VAPID Configuration

VAPID (Voluntary Application Server Identification) keys are automatically generated and stored in the database on first run. No manual configuration is required!

### Optional: Manual VAPID Configuration

If you prefer to manage VAPID keys manually:

1. Generate keys:
   ```bash
   node generate-vapid-keys.js
   ```

2. Add to `.env`:
   ```env
   VAPID_PUBLIC_KEY=your-public-key-here
   VAPID_PRIVATE_KEY=your-private-key-here
   VAPID_SUBJECT=mailto:admin@example.com
   ```

### Update Contact Email

The VAPID subject (contact email) is sent with each push notification request:

1. Go to **Configuration → Notifications** (admin only)
2. Scroll to "VAPID Configuration"
3. Update the "Contact Email" field (must start with `mailto:`)
4. Click "Update Contact Email"

## Architecture

### Backend Components

1. **Push Notification Service** (`src/server/services/pushNotificationService.ts`)
   - Manages VAPID keys (auto-generates if not present)
   - Handles subscription storage and removal
   - Sends push notifications via Web Push API
   - Tracks subscription status and handles expired subscriptions

2. **Database Schema** (`src/server/migrations/008_add_push_subscriptions.ts`)
   - Stores push subscriptions with endpoint, keys, and metadata
   - Links subscriptions to users (optional - anonymous subscriptions supported)

3. **API Endpoints** (`src/server/server.ts`)
   - `GET /api/push/vapid-key` - Get public VAPID key for subscription
   - `GET /api/push/status` - Get configuration status and subscription count
   - `POST /api/push/subscribe` - Subscribe to notifications
   - `POST /api/push/unsubscribe` - Unsubscribe from notifications
   - `PUT /api/push/vapid-subject` - Update contact email (admin only)
   - `POST /api/push/test` - Send test notification (admin only)

4. **Message Integration** (`src/server/meshtasticManager.ts`)
   - Automatically sends push notifications when new messages arrive
   - Filters out messages from the local node
   - Includes sender name and message preview

### Frontend Components

1. **Service Worker** (`src/sw.ts`)
   - Handles push events from the server
   - Shows notifications with proper iOS compliance (`event.waitUntil()`)
   - Handles notification clicks (opens/focuses app)
   - Manages subscription changes and renewals

2. **Notifications Tab** (`src/components/NotificationsTab.tsx`)
   - Browser compatibility checker
   - Permission request flow
   - Subscription management
   - iOS installation instructions
   - Admin configuration panel

3. **PWA Configuration** (`vite.config.ts`)
   - Configured with `injectManifest` strategy
   - Custom service worker with push handlers
   - Proper manifest for iOS standalone mode

## How It Works

### Subscription Flow

```
1. User clicks "Enable Notifications"
2. Browser requests permission
3. User grants permission
4. Frontend subscribes with PushManager
5. Browser generates subscription with endpoint + keys
6. Frontend sends subscription to backend API
7. Backend stores subscription in database
8. User receives push notifications
```

### Notification Flow

```
1. New message arrives on Meshtastic node
2. Backend processes and stores message
3. Backend sends push via Web Push API
4. Push service routes to user's browser
5. Service Worker receives push event
6. Service Worker shows notification
7. User sees notification (even if app closed!)
```

### iOS-Specific Handling

iOS Safari has strict requirements to prevent abuse:

- **event.waitUntil()**: Must be used to keep service worker alive
- **Silent push detection**: Sending 3+ silent pushes cancels subscription
- **PWA requirement**: Only works when installed to home screen
- **User interaction**: Permission must be requested via user action

Our implementation handles all of these requirements automatically.

## Troubleshooting

### Notifications Not Working

1. **Check Browser Support**
   - Go to Configuration → Notifications
   - Verify all checkmarks are green

2. **Check Permission**
   - Permission must be "Granted"
   - If "Denied", reset in browser settings

3. **iOS Users**
   - Ensure PWA is installed to home screen
   - Open from home screen icon, not Safari
   - iOS 16.4 or later required

4. **Check Subscription**
   - Should show "✅ Subscribed"
   - Try unsubscribing and re-subscribing

### iOS Subscription Cancelled

If iOS cancels your subscription after a few notifications:

- This happens when service worker doesn't use `event.waitUntil()`
- Our implementation already handles this correctly
- If it still happens, check browser console for errors

### Notifications Not Arriving

1. **Check VAPID Status** (admin)
   - Go to Configuration → Notifications
   - Verify "Status: ✅ Configured"
   - Check "Active Subscriptions" count

2. **Send Test Notification** (admin)
   - Click "Send Test Notification"
   - Check if test arrives

3. **Check Backend Logs**
   - Look for "📤 Sent push notification" messages
   - Check for errors in push notification sending

## Security & Privacy

- **VAPID Authentication**: All push requests are authenticated with VAPID keys
- **User Control**: Users must explicitly grant permission and subscribe
- **Endpoint Security**: Subscription endpoints are unique per user/device
- **No Personal Data**: Push payload only contains message preview
- **Subscription Management**: Users can unsubscribe anytime

## Development & Testing

### Testing Locally

1. Start development environment:
   ```bash
   npm run dev:full
   ```

2. Open http://localhost:8080

3. On iOS: Use ngrok or similar to test with HTTPS:
   ```bash
   ngrok http 8080
   ```

4. Install as PWA and test notifications

### Docker Testing

```bash
docker compose -f docker-compose.dev.yml up --build
```

### Verify Service Worker

1. Open browser DevTools
2. Go to Application → Service Workers
3. Verify service worker is registered
4. Check Console for push events

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

## Future Enhancements

Potential improvements for future releases:

- Per-channel notification settings
- Do Not Disturb schedules
- Notification sound customization
- Custom notification actions (Reply, Mark as Read)
- Deep linking to specific messages/channels
- Notification grouping by channel
- User-specific notification preferences

## References

- [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [VAPID for Web Push](https://datatracker.ietf.org/doc/html/rfc8292)
- [iOS PWA Push Notifications](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
