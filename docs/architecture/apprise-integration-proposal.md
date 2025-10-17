# Apprise Integration Proposal for MeshMonitor

## Executive Summary

This document proposes integrating [Apprise](https://github.com/caronc/apprise) and [Apprise API](https://github.com/caronc/apprise-api) as an alternative notification delivery mechanism alongside the existing Web Push implementation. This would provide users with more flexible notification options without requiring HTTPS/SSL certificates or browser-based push subscriptions.

## What is Apprise?

**Apprise** is a mature, open-source Python notification library that provides a unified interface to send notifications to 100+ services including:

- **Messaging Platforms**: Discord, Slack, Microsoft Teams, Telegram, Matrix, Mattermost, Rocket.Chat
- **SMS Services**: Twilio, Vonage (Nexmo), AWS SNS, MessageBird
- **Email**: SMTP, Gmail, Outlook, FastMail
- **Custom Webhooks**: HTTP POST (JSON/XML/Form)
- **Desktop**: Linux, macOS, Windows native notifications
- **Home Automation**: Home Assistant, IFTTT

**Apprise API** wraps this library as a lightweight REST microservice, making it accessible from any programming language including Node.js/TypeScript.

## Current MeshMonitor Notification Architecture

### Existing Web Push Implementation

The current system (v2.7.0) implements browser-based Web Push notifications:

```typescript
// Current notification flow
Message Received (meshtasticManager.ts)
  ↓
broadcastWithFiltering() (pushNotificationService.ts)
  ↓
Per-user filtering (whitelist/blacklist/channels)
  ↓
Send to browser push subscriptions via web-push library
```

**Strengths:**
- ✅ No external dependencies
- ✅ Integrated directly into browser
- ✅ Rich filtering (whitelist/blacklist/channels)
- ✅ Works on mobile PWA and desktop

**Limitations:**
- ❌ **Requires HTTPS** - Major barrier for home users
- ❌ Browser-dependent - Users must have browser open or PWA installed
- ❌ Limited to web browsers - No integration with existing tools
- ❌ iOS limitations - Requires PWA installation

## Proposed Apprise Integration

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   MeshMonitor Backend                     │
│                                                           │
│  ┌──────────────────────────────────────────┐           │
│  │    Notification Service (New Abstract)    │           │
│  │                                            │           │
│  │  ┌──────────────────┐  ┌──────────────┐  │           │
│  │  │  Web Push        │  │   Apprise    │  │           │
│  │  │  Service         │  │   Service    │  │           │
│  │  │  (Existing)      │  │   (New)      │  │           │
│  │  └──────────────────┘  └──────────────┘  │           │
│  │                                            │           │
│  │  - Per-user filtering (shared)            │           │
│  │  - Whitelist/blacklist (shared)           │           │
│  │  - Channel preferences (shared)           │           │
│  └──────────────────────────────────────────┘           │
│                       │                                   │
└───────────────────────┼───────────────────────────────────┘
                        │
         ┌──────────────┴──────────────┐
         │                             │
         ▼                             ▼
┌─────────────────┐         ┌─────────────────────┐
│   Web Browsers  │         │   Apprise API       │
│   (HTTPS/PWA)   │         │   Container         │
│                 │         │   (HTTP OK)         │
│  • Chrome       │         │                     │
│  • Firefox      │         │  Sends to:          │
│  • Safari 16+   │         │  • Discord          │
│  • Edge         │         │  • Slack            │
└─────────────────┘         │  • Telegram         │
                            │  • Email (SMTP)     │
                            │  • 100+ services    │
                            └─────────────────────┘
```

### Implementation Strategy

#### Phase 1: Apprise Service Implementation (New Module)

Create a new service module that parallels the existing push notification service:

**File: `src/server/services/appriseNotificationService.ts`**

```typescript
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

export interface AppriseNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure';
  tag?: string;
  format?: 'text' | 'markdown' | 'html';
}

export interface AppriseConfig {
  url: string;           // Apprise API URL (e.g., http://apprise-api:8000)
  configKey: string;     // Configuration key for stored URLs
  enabled: boolean;
}

class AppriseNotificationService {
  private config: AppriseConfig | null = null;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const appriseUrl = databaseService.getSetting('apprise_url');
    const appriseKey = databaseService.getSetting('apprise_config_key');
    const enabled = databaseService.getSetting('apprise_enabled') === 'true';

    if (appriseUrl && appriseKey && enabled) {
      this.config = {
        url: appriseUrl,
        configKey: appriseKey,
        enabled: true
      };
      logger.info('✅ Apprise notification service configured');
    } else {
      logger.debug('ℹ️ Apprise not configured, skipping initialization');
    }
  }

  public isAvailable(): boolean {
    return this.config !== null && this.config.enabled;
  }

  /**
   * Send notification to Apprise API using stored configuration
   */
  public async sendNotification(
    payload: AppriseNotificationPayload
  ): Promise<boolean> {
    if (!this.config) {
      logger.warn('⚠️ Apprise not configured, skipping notification');
      return false;
    }

    try {
      const url = `${this.config.url}/notify/${this.config.configKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          type: payload.type || 'info',
          tag: payload.tag,
          format: payload.format || 'text'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`❌ Apprise notification failed: ${response.status} - ${errorText}`);
        return false;
      }

      logger.debug(`✅ Sent Apprise notification: ${payload.title}`);
      return true;
    } catch (error) {
      logger.error('❌ Failed to send Apprise notification:', error);
      return false;
    }
  }

  /**
   * Send notification with per-user filtering
   */
  public async broadcastWithFiltering(
    payload: AppriseNotificationPayload,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    // Get users who have Apprise enabled
    const users = this.getUsersWithAppriseEnabled();

    let sent = 0;
    let failed = 0;
    let filtered = 0;

    for (const userId of users) {
      // Reuse existing filter logic (from pushNotificationService)
      if (this.shouldFilterNotification(userId, filterContext)) {
        filtered++;
        continue;
      }

      const success = await this.sendNotification(payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 Apprise broadcast: ${sent} sent, ${failed} failed, ${filtered} filtered`);
    return { sent, failed, filtered };
  }

  private getUsersWithAppriseEnabled(): number[] {
    // Query database for users with Apprise enabled
    // This would be a new user preference
    return [];
  }

  private shouldFilterNotification(
    userId: number,
    filterContext: any
  ): boolean {
    // Reuse existing filter logic from pushNotificationService
    // This should be extracted to a shared utility
    return false;
  }
}

export const appriseNotificationService = new AppriseNotificationService();
```

#### Phase 2: Database Schema Extensions

Add new tables and settings for Apprise configuration:

```sql
-- Migration: 009_add_apprise_support.ts

-- System-wide Apprise settings (stored in existing settings table)
INSERT INTO settings (key, value) VALUES
  ('apprise_enabled', 'false'),
  ('apprise_url', 'http://apprise-api:8000'),
  ('apprise_config_key', 'meshmonitor');

-- Per-user Apprise preferences
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,

  -- Notification method preferences
  enable_web_push BOOLEAN DEFAULT 1,
  enable_apprise BOOLEAN DEFAULT 0,

  -- Shared filtering preferences (consolidate with existing push prefs)
  enabled_channels TEXT,  -- JSON array of channel IDs
  enable_direct_messages BOOLEAN DEFAULT 1,
  whitelist TEXT,         -- JSON array of keywords
  blacklist TEXT,         -- JSON array of keywords

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id)
);
```

#### Phase 3: Unified Notification API

Create an abstraction layer that dispatches to both services:

**File: `src/server/services/notificationService.ts`**

```typescript
import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { logger } from '../../utils/logger.js';

interface NotificationPayload {
  title: string;
  body: string;
  tag?: string;
  data?: any;
}

interface FilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
}

class NotificationService {
  /**
   * Send notification via all configured channels
   */
  public async broadcast(
    payload: NotificationPayload,
    filterContext: FilterContext
  ): Promise<void> {
    const results = await Promise.allSettled([
      // Web Push (if available)
      pushNotificationService.isAvailable()
        ? pushNotificationService.broadcastWithFiltering(
            {
              title: payload.title,
              body: payload.body,
              icon: '/logo.png',
              badge: '/logo.png',
              tag: payload.tag,
              data: payload.data
            },
            filterContext
          )
        : Promise.resolve({ sent: 0, failed: 0, filtered: 0 }),

      // Apprise (if available)
      appriseNotificationService.isAvailable()
        ? appriseNotificationService.broadcastWithFiltering(
            {
              title: payload.title,
              body: payload.body,
              type: 'info',
              tag: payload.tag
            },
            filterContext
          )
        : Promise.resolve({ sent: 0, failed: 0, filtered: 0 })
    ]);

    // Log results
    results.forEach((result, index) => {
      const service = index === 0 ? 'Web Push' : 'Apprise';
      if (result.status === 'fulfilled') {
        const stats = result.value;
        logger.info(
          `${service}: ${stats.sent} sent, ${stats.failed} failed, ${stats.filtered} filtered`
        );
      } else {
        logger.error(`${service} failed:`, result.reason);
      }
    });
  }
}

export const notificationService = new NotificationService();
```

#### Phase 4: Update meshtasticManager.ts

Replace direct `pushNotificationService` calls with unified `notificationService`:

```typescript
// In meshtasticManager.ts, replace:
await pushNotificationService.broadcastWithFiltering({...}, {...});

// With:
await notificationService.broadcast({
  title,
  body,
  tag: `message-${message.id}`,
  data: { messageId: message.id, fromNodeId: message.fromNodeId }
}, {
  messageText,
  channelId: message.channel,
  isDirectMessage
});
```

#### Phase 5: Admin UI Configuration

Add Apprise configuration to the Settings page:

```typescript
// src/components/SettingsTab.tsx

<div className="settings-section">
  <h3>Apprise Integration (Alternative Notifications)</h3>

  <div className="info-box">
    <p>
      <strong>What is Apprise?</strong><br />
      Apprise allows you to send notifications to 100+ services including
      Discord, Slack, Telegram, email, SMS, and more. This is an alternative
      to browser push notifications that doesn't require HTTPS.
    </p>
    <p>
      <a href="https://github.com/caronc/apprise" target="_blank">
        Learn more about Apprise
      </a>
    </p>
  </div>

  <label>
    <input
      type="checkbox"
      checked={appriseEnabled}
      onChange={(e) => setAppriseEnabled(e.target.checked)}
    />
    Enable Apprise Notifications
  </label>

  <label>
    Apprise API URL:
    <input
      type="text"
      value={appriseUrl}
      onChange={(e) => setAppriseUrl(e.target.value)}
      placeholder="http://apprise-api:8000"
    />
  </label>

  <label>
    Configuration Key:
    <input
      type="text"
      value={appriseKey}
      onChange={(e) => setAppriseKey(e.target.value)}
      placeholder="meshmonitor"
    />
  </label>

  <button onClick={testAppriseConnection}>
    Test Apprise Connection
  </button>

  <button onClick={saveAppriseSettings}>
    Save Settings
  </button>
</div>
```

#### Phase 6: Docker Compose Integration

Add Apprise API to the Docker Compose stack:

```yaml
# docker-compose.yml addition

services:
  # ... existing meshmonitor service ...

  apprise-api:
    image: caronc/apprise:latest
    container_name: meshmonitor-apprise
    restart: unless-stopped
    ports:
      - "8001:8000"  # Expose on different port to avoid conflict
    volumes:
      - ./apprise-config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - APPRISE_STATEFUL_MODE=simple
      - APPRISE_WORKER_COUNT=1
    networks:
      - meshmonitor-network

  meshmonitor:
    # ... existing config ...
    environment:
      # Add Apprise configuration
      - APPRISE_URL=http://apprise-api:8000
      - APPRISE_CONFIG_KEY=meshmonitor
    depends_on:
      - apprise-api
```

## Advantages of Apprise Integration

### 1. **No HTTPS Requirement**
Users can send notifications without SSL certificates, removing a major barrier for home/hobbyist deployments.

### 2. **Platform Flexibility**
Users can receive notifications on their preferred platforms:
- Discord servers they already use
- Slack workspaces
- Telegram bots
- Email (existing SMTP)
- SMS services

### 3. **Existing Infrastructure Integration**
Rather than requiring browser installation, users can integrate with tools they already have running.

### 4. **Server-Side Notifications**
Notifications work even when users don't have a browser open, addressing a limitation of Web Push.

### 5. **Backward Compatibility**
The existing Web Push system remains fully functional. Users can choose one, both, or neither.

### 6. **Simple Docker Deployment**
Apprise API is a single, lightweight container with minimal configuration.

## Comparison: Web Push vs Apprise

| Feature | Web Push (Current) | Apprise (Proposed) |
|---------|-------------------|-------------------|
| **Requires HTTPS** | ✅ Yes (major limitation) | ❌ No (HTTP works) |
| **Browser Dependency** | ✅ Yes | ❌ No |
| **Mobile Support** | ✅ Good (PWA required on iOS) | ✅ Excellent (native apps) |
| **Setup Complexity** | 🟡 Medium (HTTPS setup) | 🟢 Low (Docker + config) |
| **External Dependencies** | ❌ None | ✅ Apprise API container |
| **Notification Platforms** | 🔴 Browsers only | 🟢 100+ services |
| **Works Offline** | 🟡 Browser must be open/PWA | ✅ Server-side |
| **Rich Formatting** | ✅ Yes | ✅ Yes (markdown/HTML) |
| **Per-User Filtering** | ✅ Yes | ✅ Yes (shared logic) |
| **Resource Usage** | 🟢 None (native) | 🟡 One additional container |

## Implementation Phases and Timeline

### Phase 1: Core Infrastructure (Week 1-2)
- ✅ Create `appriseNotificationService.ts`
- ✅ Add database migrations for settings
- ✅ Add Docker Compose Apprise API service
- ✅ Basic send functionality

### Phase 2: UI Integration (Week 2-3)
- ✅ Add Apprise settings to admin UI
- ✅ Test connection functionality
- ✅ Per-user notification method preferences
- ✅ Documentation

### Phase 3: Unified Notification Layer (Week 3-4)
- ✅ Create abstraction layer (`notificationService.ts`)
- ✅ Extract shared filtering logic to utilities
- ✅ Update `meshtasticManager.ts` to use unified API
- ✅ Comprehensive testing

### Phase 4: Advanced Features (Week 4-5)
- ✅ Per-service configuration (different Apprise configs for different users)
- ✅ Rate limiting per service
- ✅ Notification delivery statistics
- ✅ Health monitoring for Apprise API

### Phase 5: Documentation and Polish (Week 5-6)
- ✅ User documentation for Apprise setup
- ✅ Example configurations for popular services (Discord, Slack, Telegram)
- ✅ Migration guide for existing users
- ✅ Performance testing and optimization

## Migration Strategy for Existing Users

### Option 1: Additive (Recommended)
Keep Web Push as default, add Apprise as opt-in:

```
Existing users → Keep Web Push (no changes required)
New users → Choose Web Push OR Apprise OR Both
HTTP-only users → Can now use Apprise
```

### Option 2: Gradual Migration
Encourage migration to Apprise with deprecation timeline:

```
v2.8.0: Add Apprise support (Web Push still default)
v2.9.0: Make Apprise default for new installs
v3.0.0: Consider deprecating Web Push
```

**Recommendation: Use Option 1** - Keep both systems indefinitely. They serve different use cases.

## Configuration Examples

### Example 1: Discord Webhook

```bash
# In Apprise API, configure:
POST /add/meshmonitor
{
  "urls": "discord://webhook_id/webhook_token"
}

# MeshMonitor settings:
APPRISE_URL=http://apprise-api:8000
APPRISE_CONFIG_KEY=meshmonitor
```

### Example 2: Multiple Services

```bash
# Apprise supports multiple URLs in one config
POST /add/meshmonitor
{
  "urls": [
    "discord://webhook_id/token",
    "slack://token_a/token_b/token_c",
    "mailto://user:password@gmail.com"
  ]
}
```

### Example 3: Tagged Notifications

```bash
# Different services for different priority levels
POST /add/meshmonitor
{
  "urls": [
    "discord://webhook_id/token?tag=priority",
    "mailto://alerts@example.com?tag=all"
  ]
}

# MeshMonitor can then send with tags:
{
  "title": "Emergency Alert",
  "body": "Node down",
  "tag": "priority"  // Only Discord receives this
}
```

## Security Considerations

### 1. **Apprise API Access**
- Deploy Apprise API on private network (Docker internal network)
- Don't expose Apprise API port to internet
- Use Docker networking: `http://apprise-api:8000` (internal only)

### 2. **Configuration Storage**
- Apprise URLs contain sensitive tokens (Discord webhooks, Slack tokens)
- These are stored IN the Apprise API container, not in MeshMonitor
- MeshMonitor only stores the configuration key, not the actual URLs

### 3. **User Permissions**
- Only admins can configure Apprise API URL
- Regular users can only enable/disable their own Apprise notifications
- Shared Apprise config means all users send to same destinations

### 4. **Rate Limiting**
- Implement rate limiting in MeshMonitor to prevent abuse
- Apprise API has built-in rate limiting
- Consider per-service quotas

## Testing Strategy

### Unit Tests
```typescript
describe('AppriseNotificationService', () => {
  it('should send notification to Apprise API', async () => {
    // Mock fetch
    // Test successful send
  });

  it('should handle Apprise API failures gracefully', async () => {
    // Mock API error
    // Verify error handling
  });

  it('should apply filtering before sending', async () => {
    // Test whitelist/blacklist logic
  });
});
```

### Integration Tests
```typescript
describe('Notification Service Integration', () => {
  it('should send to both Web Push and Apprise', async () => {
    // Mock both services
    // Verify both receive notifications
  });

  it('should continue if one service fails', async () => {
    // Fail Apprise, succeed Web Push
    // Verify graceful degradation
  });
});
```

### Manual Testing Checklist
- [ ] Docker Compose starts Apprise API successfully
- [ ] Admin can configure Apprise in UI
- [ ] Test connection verifies Apprise API accessibility
- [ ] Notifications send to Discord webhook
- [ ] Notifications send to Slack channel
- [ ] Notifications send via SMTP
- [ ] Filtering works correctly (whitelist/blacklist)
- [ ] Both Web Push and Apprise work simultaneously
- [ ] System works gracefully when Apprise API is down

## Documentation Requirements

### User Documentation
1. **Quick Start Guide**: "Setting up Apprise Notifications"
2. **Service-Specific Guides**:
   - Discord webhook setup
   - Slack app setup
   - Telegram bot setup
   - Gmail SMTP setup
3. **Comparison Guide**: "Web Push vs Apprise: Which to choose?"
4. **Troubleshooting**: Common issues and solutions

### Developer Documentation
1. **Architecture Diagram**: Notification flow
2. **API Reference**: Apprise service methods
3. **Extension Guide**: Adding new notification methods
4. **Testing Guide**: Running integration tests

## Risks and Mitigation

### Risk 1: Apprise API Downtime
**Impact**: Notifications fail
**Mitigation**:
- Health check endpoint in MeshMonitor
- Automatic fallback to Web Push only
- Admin alerts when Apprise is down

### Risk 2: External Service Rate Limiting
**Impact**: Discord/Slack/etc block notifications
**Mitigation**:
- Implement local rate limiting
- Batch notifications where possible
- Queue system for high-volume deployments

### Risk 3: Configuration Complexity
**Impact**: Users struggle to set up
**Mitigation**:
- Provide detailed documentation
- Example configurations for popular services
- Test connection button with helpful error messages
- Video tutorials

### Risk 4: Additional Resource Usage
**Impact**: One more Docker container
**Mitigation**:
- Apprise API is very lightweight (~50MB)
- Optional - users can disable if not needed
- Resource limits in Docker Compose

## Success Metrics

### Adoption Metrics
- % of users who enable Apprise
- Most popular services (Discord vs Slack vs email)
- Users using both Web Push and Apprise
- Users switching from Web Push to Apprise only

### Performance Metrics
- Notification delivery time (P50, P95, P99)
- Failure rate for Apprise notifications
- Impact on MeshMonitor server resources
- Apprise API uptime

### User Satisfaction
- GitHub issues related to notification delivery
- User feedback on notification reliability
- Support requests for setup assistance

## Conclusion

Integrating Apprise provides significant value to MeshMonitor users by:

1. **Removing HTTPS Barrier**: The #1 limitation of Web Push
2. **Platform Flexibility**: 100+ notification services
3. **Better UX for Home Users**: No browser dependency
4. **Backward Compatibility**: Existing users unaffected

**Recommended Next Steps:**
1. Implement Phase 1 (core infrastructure) in v2.8.0
2. Gather user feedback on setup experience
3. Iterate based on most-requested services
4. Add advanced features (per-user configs) in v2.9.0

The implementation is low-risk, high-reward, and aligns perfectly with MeshMonitor's goal of being accessible to home/hobbyist users.
