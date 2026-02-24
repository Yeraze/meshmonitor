# Proxy Compatibility Analysis: MeshMonitor + Home Assistant

**Analysis Date:** 2025-10-01
**Status:** Research Complete

## Executive Summary

This document analyzes the effort required to make MeshMonitor compatible with Meshtastic proxy solutions, particularly the Home Assistant integration and websocket-based proxies. The recommended approach is to implement WebSocket client mode to connect to existing proxy servers, requiring approximately 2-3 days of development effort.

## What the Home Assistant Integration Actually Provides

After investigating the [meshtastic/home-assistant](https://github.com/meshtastic/home-assistant) repository, we found that **it does NOT provide a TCP proxy**. Instead, it offers:

1. **HTTP API Proxy** - The integration exposes Meshtastic's standard HTTP API (`/api/v1/toradio` and `/api/v1/fromradio`) to the Home Assistant web client
2. **Web UI Bundled** - Includes the official Meshtastic web client for browser-based interaction
3. **Connection Multiplexing** - Not actually a multi-client proxy; it's more of a connection abstraction layer

The README mentions "TCP Proxy" loosely, but the implementation is actually an **HTTP-to-Device proxy** that allows the web client to connect to serial/Bluetooth Meshtastic devices through Home Assistant.

### Home Assistant Integration Architecture

```
┌─────────────────┐
│  Meshtastic     │
│  Web Client     │
│  (Browser)      │
└────────┬────────┘
         │ HTTP
         ├─────────────┐
         │             │
┌────────▼────────┐    │
│ Home Assistant  │    │
│ HTTP Proxy      │    │
│ /api/v1/*       │    │
└────────┬────────┘    │
         │             │
         │ Serial/BLE  │ HTTP (Direct)
         │             │
    ┌────▼─────────────▼────┐
    │  Meshtastic Device    │
    └───────────────────────┘
```

**Key Limitation:** The Home Assistant proxy doesn't solve the multi-client problem. It simply allows the web client to connect to devices that don't support TCP/HTTP (serial, Bluetooth) or provides a single web interface.

## Better Alternative: meshtastic-websocket-proxy

The more relevant project is **[liamcottle/meshtastic-websocket-proxy](https://github.com/liamcottle/meshtastic-websocket-proxy)**, which:

- Solves the "one client at a time" limitation of Meshtastic's HTTP API
- Provides a **WebSocket server** that multiple clients can connect to simultaneously
- Forwards `FromRadio` packets to all connected clients
- Accepts `ToRadio` packets from any client
- Sends packets as JSON with base64-encoded protobufs

### WebSocket Proxy Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ MeshMonitor  │  │ Web Client   │  │ Other App    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ WebSocket       │ WebSocket       │ WebSocket
       ├─────────────────┼─────────────────┤
       │                 │                 │
┌──────▼─────────────────▼─────────────────▼───────┐
│  meshtastic-websocket-proxy                      │
│  - Broadcasts FromRadio to all clients           │
│  - Accepts ToRadio from any client               │
│  - Single HTTP connection to device              │
└──────────────────────┬───────────────────────────┘
                       │ HTTP
                       │ /api/v1/toradio
                       │ /api/v1/fromradio
                  ┌────▼──────┐
                  │ Meshtastic│
                  │   Device  │
                  └───────────┘
```

### WebSocket Proxy Protocol

**Receiving Messages (FromRadio):**
```json
{
  "type": "from_radio",
  "protobuf": "CgQIARACEAE=",
  "json": {
    "decoded": {
      "portnum": "TEXT_MESSAGE_APP",
      "payload": "..."
    }
  }
}
```

**Sending Messages (ToRadio):**
```json
{
  "type": "to_radio",
  "protobuf": "CgQIARACEAE="
}
```

## Current MeshMonitor Architecture

MeshMonitor currently:
- ✅ Connects directly to a Meshtastic node via HTTP API
- ✅ Uses `/api/v1/fromradio` and `/api/v1/toradio` endpoints
- ✅ Handles protobuf encoding/decoding internally
- ✅ Polls for updates every few seconds
- ❌ Cannot share node access with other applications

### Current Connection Flow

```typescript
// src/server/meshtasticManager.ts
private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const url = `${this.getBaseUrl()}${endpoint}`;
  return await fetch(url, options);
}

// Polling implementation
private async pollForUpdates(): Promise<void> {
  const response = await this.makeRequest('/api/v1/fromradio?all=false');
  // Process response...
}

// Sending messages
async sendTextMessage(text: string, destination: string, channel: number) {
  const response = await this.makeRequest('/api/v1/toradio', {
    method: 'PUT',
    body: textMessageData,
    headers: { 'Content-Type': 'application/x-protobuf' }
  });
}
```

## Compatibility Implementation Options

### Option 1: WebSocket Client Mode (Recommended)
**Effort: Medium (2-3 days)**

Add ability to connect to `meshtastic-websocket-proxy` instead of direct HTTP.

#### Changes Needed

1. **Configuration**
   - Add `CONNECTION_TYPE` env var: `http` | `websocket`
   - Add `WEBSOCKET_PROXY_URL` env var: `ws://localhost:8080`

2. **Connection Abstraction**
   ```typescript
   // src/server/connections/IMeshtasticConnection.ts
   interface IMeshtasticConnection {
     connect(): Promise<boolean>;
     disconnect(): Promise<void>;
     sendToRadio(data: Uint8Array): Promise<void>;
     onFromRadio(callback: (data: Uint8Array) => void): void;
     isConnected(): boolean;
   }
   ```

3. **HTTP Connection Implementation**
   ```typescript
   // src/server/connections/HttpConnection.ts
   class HttpConnection implements IMeshtasticConnection {
     // Refactor existing HTTP polling logic
     private pollingInterval: NodeJS.Timeout | null = null;

     async connect(): Promise<boolean> {
       // Existing connection logic
       this.startPolling();
     }

     async sendToRadio(data: Uint8Array): Promise<void> {
       await fetch('/api/v1/toradio', {
         method: 'PUT',
         body: data,
         headers: { 'Content-Type': 'application/x-protobuf' }
       });
     }
   }
   ```

4. **WebSocket Connection Implementation**
   ```typescript
   // src/server/connections/WebSocketConnection.ts
   class WebSocketConnection implements IMeshtasticConnection {
     private ws: WebSocket | null = null;
     private callbacks: Array<(data: Uint8Array) => void> = [];

     async connect(): Promise<boolean> {
       this.ws = new WebSocket(this.url);

       this.ws.on('message', (data: string) => {
         const message = JSON.parse(data);
         if (message.type === 'from_radio') {
           const protobufData = Buffer.from(message.protobuf, 'base64');
           this.callbacks.forEach(cb => cb(protobufData));
         }
       });
     }

     async sendToRadio(data: Uint8Array): Promise<void> {
       const base64 = Buffer.from(data).toString('base64');
       this.ws.send(JSON.stringify({
         type: 'to_radio',
         protobuf: base64
       }));
     }
   }
   ```

5. **Update MeshtasticManager**
   ```typescript
   class MeshtasticManager {
     private connection: IMeshtasticConnection;

     constructor() {
       const type = process.env.CONNECTION_TYPE || 'http';
       if (type === 'websocket') {
         this.connection = new WebSocketConnection(
           process.env.WEBSOCKET_PROXY_URL
         );
       } else {
         this.connection = new HttpConnection({
           nodeIp: process.env.MESHTASTIC_NODE_IP,
           useTls: process.env.MESHTASTIC_USE_TLS === 'true'
         });
       }
     }

     async connect(): Promise<boolean> {
       await this.connection.connect();
       this.connection.onFromRadio((data) => {
         this.processIncomingData(data);
       });
     }
   }
   ```

#### Benefits
- ✅ Multiple applications can monitor same node
- ✅ Real-time push instead of polling (more efficient)
- ✅ Cleaner separation of concerns
- ✅ Compatible with existing websocket-proxy ecosystem
- ✅ Minimal changes to core logic (protobuf handling stays the same)
- ✅ Can maintain both HTTP direct and WebSocket modes

#### Dependencies
- `ws` package (WebSocket client for Node.js)
- Running instance of `meshtastic-websocket-proxy`

#### Testing Strategy
1. Unit tests for connection implementations
2. Integration tests with mock WebSocket server
3. Manual testing with actual websocket-proxy
4. Ensure backwards compatibility with HTTP mode

---

### Option 2: Built-in Proxy Server
**Effort: High (5-7 days)**

Make MeshMonitor itself act as a proxy server.

#### Changes Needed

1. **Add WebSocket Server**
   ```typescript
   // src/server/proxyServer.ts
   import { WebSocketServer } from 'ws';

   class MeshtasticProxyServer {
     private wss: WebSocketServer;
     private clients: Set<WebSocket> = new Set();
     private meshtasticConnection: HttpConnection;

     start(port: number) {
       this.wss = new WebSocketServer({ port });

       this.wss.on('connection', (ws) => {
         this.clients.add(ws);

         ws.on('message', (data) => {
           // Forward ToRadio to Meshtastic
           this.handleClientMessage(data);
         });

         ws.on('close', () => {
           this.clients.delete(ws);
         });
       });

       // Broadcast FromRadio to all clients
       this.meshtasticConnection.onFromRadio((data) => {
         this.broadcastToClients(data);
       });
     }

     private broadcastToClients(data: Uint8Array) {
       const base64 = Buffer.from(data).toString('base64');
       const message = JSON.stringify({
         type: 'from_radio',
         protobuf: base64
       });

       this.clients.forEach(client => {
         if (client.readyState === WebSocket.OPEN) {
           client.send(message);
         }
       });
     }
   }
   ```

2. **Maintain Single HTTP Connection**
   - Keep one connection to physical Meshtastic node
   - Handle connection state management
   - Implement reconnection logic

3. **Handle Client Management**
   - Track connected clients
   - Handle client disconnection gracefully
   - Implement connection limits if needed

4. **Add Proxy Management UI**
   - Display connected clients
   - Show proxy statistics
   - Enable/disable proxy mode
   - Configure proxy settings

5. **Update Configuration**
   - Add `ENABLE_PROXY_SERVER` env var
   - Add `PROXY_PORT` env var (default: 8081)
   - Add `MAX_PROXY_CLIENTS` env var

#### Benefits
- ✅ All-in-one solution
- ✅ No external dependencies
- ✅ Could add authentication layer
- ✅ Full control over proxy behavior
- ✅ Could add custom features (message filtering, logging, etc.)

#### Drawbacks
- ❌ Significantly more complex implementation
- ❌ Duplicates existing websocket-proxy work
- ❌ Harder to maintain
- ❌ More testing required
- ❌ Higher resource usage
- ❌ Increased attack surface

---

### Option 3: Home Assistant API Compatibility
**Effort: Low-Medium (1-2 days)**

Add endpoints that mimic Home Assistant's proxy pattern.

#### Changes Needed

1. **Add Proxy Endpoints**
   ```typescript
   // src/server/server.ts

   // Proxy toradio to configured node
   app.put('/api/v1/toradio', async (req, res) => {
     const data = await req.arrayBuffer();
     const response = await fetch(
       `http://${MESHTASTIC_NODE_IP}/api/v1/toradio`,
       {
         method: 'PUT',
         body: data,
         headers: { 'Content-Type': 'application/x-protobuf' }
       }
     );
     res.status(response.status).send(await response.arrayBuffer());
   });

   // Proxy fromradio to configured node
   app.get('/api/v1/fromradio', async (req, res) => {
     const all = req.query.all || 'false';
     const response = await fetch(
       `http://${MESHTASTIC_NODE_IP}/api/v1/fromradio?all=${all}`
     );
     res.status(response.status).send(await response.arrayBuffer());
   });
   ```

2. **Add Configuration**
   - Add `ENABLE_API_PROXY` env var
   - Document proxy endpoints

#### Benefits
- ✅ Could work with Home Assistant web client
- ✅ Simple implementation
- ✅ Pass-through with minimal logic
- ✅ Easy to test

#### Drawbacks
- ❌ Doesn't solve multi-client problem
- ❌ Limited value since MeshMonitor already has better UI
- ❌ Would need to reverse-engineer HA's exact API
- ❌ Still subject to "one client at a time" limitation
- ❌ Adds complexity without much benefit

---

## Recommendation

**Implement Option 1: WebSocket Client Mode**

This provides the best balance of:
- ✅ Reasonable implementation effort (2-3 days)
- ✅ Solves the multi-client access problem
- ✅ Uses proven existing proxy (liamcottle's websocket-proxy)
- ✅ Minimal disruption to current architecture
- ✅ Can maintain both HTTP direct and WebSocket modes
- ✅ Better performance (push vs. poll)
- ✅ Follows established patterns

## Implementation Plan

If proceeding with **Option 1: WebSocket Client Mode**:

### Phase 1: Preparation (0.5 days)
1. Add `ws` package to dependencies
2. Create `src/server/connections/` directory
3. Define `IMeshtasticConnection` interface
4. Update environment variables documentation

### Phase 2: Refactoring (1 day)
1. Create `HttpConnection.ts` class
2. Extract existing HTTP logic from `MeshtasticManager`
3. Implement `IMeshtasticConnection` interface
4. Update `MeshtasticManager` to use connection abstraction
5. Test HTTP mode still works

### Phase 3: WebSocket Implementation (1 day)
1. Create `WebSocketConnection.ts` class
2. Implement WebSocket connection logic
3. Handle JSON message parsing (from_radio/to_radio)
4. Implement base64 protobuf encoding/decoding
5. Add reconnection logic

### Phase 4: Integration & Testing (0.5 days)
1. Add connection type selection in `MeshtasticManager` constructor
2. Write unit tests for both connection types
3. Test with actual `meshtastic-websocket-proxy`
4. Update documentation with setup instructions
5. Add connection type indicator in UI (optional)

### File Structure
```
src/server/
├── connections/
│   ├── IMeshtasticConnection.ts    # Interface definition
│   ├── HttpConnection.ts           # HTTP polling implementation
│   └── WebSocketConnection.ts      # WebSocket client implementation
├── meshtasticManager.ts            # Updated to use connection abstraction
└── server.ts                       # Express server (minimal changes)
```

### Configuration Example

**Direct HTTP Mode (Current):**
```yaml
environment:
  - CONNECTION_TYPE=http
  - MESHTASTIC_NODE_IP=192.168.1.100
  - MESHTASTIC_USE_TLS=false
```

**WebSocket Proxy Mode (New):**
```yaml
environment:
  - CONNECTION_TYPE=websocket
  - WEBSOCKET_PROXY_URL=ws://localhost:8080
```

### Documentation Updates
- Update README.md with proxy mode instructions
- Create docs/proxy-setup.md with detailed setup guide
- Add troubleshooting section for proxy connections
- Document environment variables

## Alternative Proxy Solutions

### Using meshtastic-websocket-proxy

**Setup:**
```bash
# Install proxy
npm install -g @liamcottle/meshtastic-websocket-proxy

# Run proxy connected to your node
meshtastic-websocket-proxy \
  --host 192.168.1.100 \
  --port 8080
```

**MeshMonitor Configuration:**
```yaml
services:
  proxy:
    image: ghcr.io/liamcottle/meshtastic-websocket-proxy:latest
    environment:
      - MESHTASTIC_HOST=192.168.1.100
    ports:
      - "8080:8080"

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - CONNECTION_TYPE=websocket
      - WEBSOCKET_PROXY_URL=ws://proxy:8080
    ports:
      - "8081:3001"
```

## Conclusion

The Home Assistant integration provides limited value for MeshMonitor, but the websocket-proxy ecosystem offers a proven solution for multi-client access. Implementing WebSocket client mode in MeshMonitor is the most practical approach, requiring moderate effort while providing significant benefits.

The existing protobuf service and database logic remain unchanged, making this a relatively low-risk enhancement that dramatically improves MeshMonitor's flexibility in multi-application environments.

## References

- [meshtastic/home-assistant](https://github.com/meshtastic/home-assistant) - Home Assistant Integration
- [liamcottle/meshtastic-websocket-proxy](https://github.com/liamcottle/meshtastic-websocket-proxy) - WebSocket Proxy
- [Meshtastic HTTP API Documentation](https://meshtastic.org/docs/development/device/http-api/)
- [Meshtastic Client API Documentation](https://meshtastic.org/docs/development/device/client-api/)
