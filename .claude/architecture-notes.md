# MeshMonitor Architecture

Quick architectural reference for AI agents.

## System Overview

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ React App       │────│ Express API     │────│ SQLite Database│
│ (Frontend)      │ │ (Backend)       │ │ (Persistence)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
        │                   │                    │
        └────────────────────┼────────────────────┘
                            │ TCP Connection (Event-Driven)
                            ↓
                 ┌─────────────────────────┐
                 │ Meshtastic Node         │
                 │ TCP Port 4403           │
                 └─────────────────────────┘
```

## Stack

**Frontend**: React 19 + TypeScript + Vite + Catppuccin Mocha theme
**Backend**: Node.js 22 + Express + TypeScript
**Database**: SQLite (better-sqlite3)
**Protocol**: Meshtastic Protobuf over TCP (event-driven, not polling)

## TCP Streaming Protocol

**Frame Structure:**
```
[0x94][0x93][LENGTH_MSB][LENGTH_LSB][PROTOBUF_PAYLOAD]
```

**Benefits:**
- ~90% bandwidth reduction vs HTTP polling
- Real-time event delivery
- Automatic reconnection with exponential backoff

**Connection Flow:**
1. TCP socket connects to node:4403
2. Backend sends `want_config_id`
3. Node streams config (myInfo, channels, nodes)
4. Event-driven processing begins

## Message Structure

```typescript
interface MeshMessage {
  id: string;
  from: string;              // Short ID (e.g., "!12345678")
  to: string;                // "^all" or node ID
  text: string;
  timestamp: Date;
  channel: number;
  replyId?: number;          // Threading support
  emoji?: number;            // 0=normal, 1=reaction
  acknowledged?: boolean;
  hopStart?: number;
  hopLimit?: number;
}
```

**Features:**
- Direct messaging and channel broadcasts
- Reply threading
- Emoji reactions (👍 👎 ❓ ❗ 😂 😢 💩)
- Optimistic UI updates

## Database Schema

**Key Tables:**
- `messages` - Text messages with threading/reactions
- `nodes` - Device information and telemetry
- `traceroutes` - Network topology with SNR
- `channels` - Channel configuration

**Features:**
- Automatic deduplication
- Cross-restart persistence
- Export/import functionality

## API Endpoints

### Core Endpoints
- `GET /api/nodes` - All nodes
- `GET /api/messages` - Paginated messages
- `POST /api/messages/send` - Send message
- `GET /api/traceroutes/recent` - Recent traceroutes
- `POST /api/export` - Export all data
- `GET /api/health` - Health check

## Adding New Settings

Settings use a key-value pattern stored in SQLite. To add a new setting:

1. **Backend (server.ts)**: Add key to `validKeys` array in POST `/api/settings` handler (~line 3238)
2. **Frontend State**: Add to UIContext or SettingsContext as needed
3. **Settings UI**: Add to SettingsTab.tsx with local state for change tracking
4. **Load on Startup**: Add loading in App.tsx `initializeApp()` if needed globally

**Critical**: New settings MUST be in `validKeys` or they're silently dropped on save.

## Environment Variables

```bash
MESHTASTIC_NODE_IP=192.168.1.100  # Node IP
MESHTASTIC_TCP_PORT=4403          # TCP port
BASE_URL=                         # Runtime subfolder path
```

**BASE_URL** is runtime-only (no rebuild needed). Same image works for root or any subfolder.

## Design Decisions

**Why TCP Streaming?**
- Real-time data delivery
- Efficient bandwidth usage
- Event-driven architecture

**Why SQLite?**
- Zero configuration
- File-based persistence
- Excellent performance
- Easy backup

**Why Catppuccin Theme?**
- Soothing, high contrast
- Consistent across app
- Popular in dev community

**Why React + Express Monorepo?**
- Simplified deployment (single container)
- Shared TypeScript types
- Unified build process

## Connection Methods

1. **Direct TCP** - WiFi/Ethernet nodes (standard)
2. **meshtasticd Proxy** - BLE/Serial to TCP bridge
3. **HomeAssistant** - Via MQTT bridge
4. **Custom Proxies** - Any TCP implementation

## Security

**No built-in auth** - assumes trusted environment

**Recommendations:**
- Use reverse proxy with auth
- Don't expose to internet
- Consider VPN for remote access
- Enable HTTPS via reverse proxy

## Performance

- **WebSocket overhead**: Minimal (binary frames)
- **Database size**: ~1KB per message
- **Memory usage**: ~50-100MB typical
- **Reconnection**: 1-30s (exponential backoff)
- **Message latency**: Near real-time (<100ms)

## Known Limitations

1. **Single Node Connection** - connects to one node (acts as gateway)
2. **No End-to-End Encryption UI** - uses Meshtastic encryption, no key management UI
3. **WebSocket Session Conflicts** - known issue on Synology NAS (under investigation)

## Troubleshooting

**Cannot Connect:**
- Verify IP and port 4403
- Test with `nc -zv <IP> 4403`
- Check firewall rules

**Database Errors:**
- Verify `/data` permissions
- Check disk space

**Build Failures:**
- Check Node.js version (20+ required)
- Update git submodules (protobufs)
- Clear node_modules, reinstall
