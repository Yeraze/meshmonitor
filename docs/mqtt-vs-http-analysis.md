# MQTT vs HTTP API Architecture Analysis

## Executive Summary

This document analyzes the potential architectural change from using Meshtastic's HTTP API to an MQTT-based approach for MeshMonitor. The analysis concludes that the current HTTP-based architecture is appropriate for MeshMonitor's use case, but MQTT could be considered as an optional enhancement for specific scenarios.

**Recommendation**: Maintain current HTTP API architecture. Consider MQTT as an optional future enhancement only if specific use cases emerge (multi-instance monitoring, Home Assistant integration, etc.).

---

## Current Architecture (HTTP API)

MeshMonitor currently uses the Meshtastic HTTP API with direct polling:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React App     │────│   Express API   │────│  SQLite Database│
│  (Frontend)     │    │   (Backend)     │    │   (Persistence) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                        │                        │
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                     ┌─────────────────┐
                     │ Meshtastic Node │
                     │   (HTTP API)    │
                     └─────────────────┘
```

- Backend polls `/api/v1/fromradio` endpoint
- Sends messages via `/api/v1/toradio` endpoint
- Direct request/response model
- Simple, reliable, low complexity

---

## PROS of Switching to MQTT

### 1. Push vs. Pull Model
- **Current**: Backend actively polls `/fromradio` endpoint
- **MQTT**: Subscribe to topics, receive packets as published (event-driven)
- **Benefit**: Lower latency, reduced bandwidth, more efficient resource usage

### 2. Access to More Data Types
MQTT with JSON enabled provides automatic deserialization for:
- `TEXT_MESSAGE_APP` - Text messages
- `TELEMETRY_APP` - Device telemetry
- `NODEINFO_APP` - Node information
- `POSITION_APP` - GPS positions
- `WAYPOINT_APP` - Waypoints
- `NEIGHBORINFO_APP` - Neighbor info
- `TRACEROUTE_APP` - Traceroute responses ✅
- `DETECTION_SENSOR_APP` - Sensor data
- `PAXCOUNTER_APP` - People counting
- `REMOTE_HARDWARE_APP` - Hardware control

### 3. Reduced Load on Node
- No continuous HTTP polling pressure on the Meshtastic device
- Node publishes once to broker, multiple clients can subscribe
- Better for node battery life and stability
- Less CPU/memory overhead on constrained embedded device

### 4. Better Multi-Client Support
- Multiple MeshMonitor instances could connect to same MQTT broker
- Centralized data aggregation possible
- Could support distributed architecture
- Multiple consumers of same mesh data without multiplying node load

### 5. Network Resilience
- MQTT has built-in QoS (Quality of Service) levels (0, 1, 2)
- Automatic reconnection handling with configurable retry logic
- Better handling of intermittent connectivity
- Session persistence and message queuing

### 6. Access to Broader Network
- If node is configured as MQTT gateway, you get packets from the **entire mesh**, not just direct connections
- Could monitor multiple nodes through single MQTT broker
- Easier integration with mesh networks spanning multiple physical locations
- Gateway functionality for internet-to-mesh communication

---

## CONS of Switching to MQTT

### 1. Loss of Direct Node Control
- **HTTP API**: Direct read/write to node configuration
- **MQTT**: Primarily for packet transmission, limited config access
- **Impact**: Would still need HTTP API for:
  - Device configuration requests (`wantConfigId`)
  - Channel management
  - Admin operations
  - Direct node status queries
  - Reading node metadata and capabilities

### 2. Increased Complexity
- Need Mosquitto or similar broker in container
- Additional configuration layer (broker + node connection)
- More moving parts to debug and maintain
- More potential failure points in the system
- User must configure MQTT module on their Meshtastic node
- Additional networking knowledge required for troubleshooting

### 3. Deployment Changes
Would require container infrastructure changes:

```yaml
# docker-compose.yml additions needed
services:
  mosquitto:
    image: eclipse-mosquitto
    ports:
      - "1883:1883"
    volumes:
      - mosquitto-config:/mosquitto/config
      - mosquitto-data:/mosquitto/data

  meshmonitor:
    depends_on:
      - mosquitto
    environment:
      - MQTT_BROKER_HOST=mosquitto
      - MQTT_BROKER_PORT=1883
```

### 4. Configuration Burden
Users would need to configure their Meshtastic node:
- Enable MQTT module via device settings
- Configure broker address (either MeshMonitor container or external)
- Set MQTT username/password if authentication enabled
- Enable uplink/downlink per channel
- Configure encryption if desired (`mqtt.encryption_enabled`)
- Set appropriate root topic (`mqtt.root_topic`)

This significantly increases the barrier to entry compared to "just enter your node's IP address."

### 5. Potential Data Loss During Initial Config
- HTTP API gives immediate request/response with retries
- MQTT subscription might miss packets sent before subscription established
- Need careful initialization sequence
- Message buffering/queuing considerations for reliability
- Potential missed config messages during startup

### 6. Limited Administrative Control
- Cannot request specific data on-demand (must wait for publish)
- Cannot directly read node configuration synchronously
- Traceroute sending would still likely need HTTP for ToRadio messages
- Configuration queries (`wantConfigId`) not available via MQTT
- Polling-based workflows (like requesting fresh node list) don't map well to pub/sub

### 7. Encryption Complexity
- MQTT encryption is separate from channel encryption
- Must be explicitly enabled on node (`mqtt.encryption_enabled`)
- Additional security consideration and configuration
- TLS certificate management for secure broker connections
- Potential for misconfiguration exposing mesh data

### 8. Message Format Ambiguity
- MQTT can provide both raw protobufs AND JSON
- JSON is platform-dependent (not available on nRF52)
- Need to handle both formats or document platform requirements
- Additional parsing logic complexity

---

## Fundamental Technology Changes Required

### 1. Container Infrastructure

**Option A: Multi-container approach**
```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:latest
    volumes:
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf
      - mosquitto-data:/mosquitto/data
    ports:
      - "1883:1883"

  meshmonitor:
    depends_on:
      - mosquitto
    environment:
      - MQTT_BROKER_HOST=mosquitto
```

**Option B: Embedded broker in main container**
```dockerfile
FROM node:20-alpine
RUN apk add --no-cache mosquitto
# ... copy mosquitto config
# ... supervisor or process manager to run both
```

### 2. Backend Architecture Changes

```typescript
// New MQTT Manager Service
import mqtt from 'mqtt';

class MeshtasticMqttManager {
  private client: mqtt.MqttClient;
  private rootTopic: string;

  async connect(brokerUrl: string, options: mqtt.IClientOptions) {
    this.client = mqtt.connect(brokerUrl, {
      ...options,
      will: {
        topic: `${this.rootTopic}/status`,
        payload: 'offline',
        qos: 1,
        retain: true
      }
    });

    // Subscribe to all mesh topics
    this.client.subscribe(`${this.rootTopic}/#`, { qos: 1 });

    // Handle incoming messages
    this.client.on('message', (topic, message) => {
      try {
        // Parse ServiceEnvelope protobuf OR JSON
        const data = this.parseMessage(message);
        this.handleMeshPacket(data);
      } catch (error) {
        console.error('Failed to parse MQTT message:', error);
      }
    });

    // Handle connection events
    this.client.on('connect', () => {
      console.log('✅ Connected to MQTT broker');
    });

    this.client.on('error', (error) => {
      console.error('❌ MQTT connection error:', error);
    });

    this.client.on('reconnect', () => {
      console.log('🔄 Reconnecting to MQTT broker...');
    });
  }

  private parseMessage(message: Buffer): any {
    // Try JSON first (if mqtt.json_enabled on node)
    try {
      return JSON.parse(message.toString());
    } catch {
      // Fall back to protobuf parsing
      return this.parseProtobuf(message);
    }
  }

  private handleMeshPacket(data: any): void {
    // Process mesh packet and store in database
    // Similar to existing HTTP polling logic
  }

  // Still need HTTP for sending!
  async sendMessage(text: string, destination?: number, channel?: number): Promise<void> {
    // HTTP API call to /api/v1/toradio
    // MQTT downlink is unreliable for this use case
  }
}
```

### 3. Dual-Mode Operation (Most Likely Necessary)

You'd probably need **both** HTTP and MQTT:

**MQTT Used For:**
- Receiving mesh packets (messages, telemetry, positions)
- Real-time event notification
- Passive monitoring

**HTTP Still Used For:**
- Sending messages (`POST /api/v1/toradio`)
- Requesting node configuration
- Administrative operations
- Traceroute initiation
- Synchronous request/response workflows

### 4. Database Schema Impact

**Minimal changes required:**
- Same packet types arrive via different transport
- Existing `messages`, `nodes`, `traceroutes` tables work as-is
- Might add `mqtt_status` table for broker connection tracking
- Might add `packet_source` field to track HTTP vs MQTT origin

### 5. New Environment Variables

```bash
# Existing
MESHTASTIC_NODE_IP=192.168.1.100
MESHTASTIC_USE_TLS=false

# New MQTT variables
MQTT_ENABLED=true
MQTT_BROKER_HOST=mosquitto
MQTT_BROKER_PORT=1883
MQTT_ROOT_TOPIC=msh/US
MQTT_USERNAME=meshmonitor
MQTT_PASSWORD=secret
MQTT_USE_TLS=false
MQTT_CLIENT_ID=meshmonitor-001

# Hybrid mode settings
USE_MQTT_FOR_RECEIVE=true
USE_HTTP_FOR_SEND=true
```

### 6. Frontend Changes

**Minimal:**
- Connection status UI needs to show both HTTP and MQTT status
- Settings page needs MQTT configuration options
- Error handling for broker connectivity issues

### 7. New Dependencies

```json
{
  "dependencies": {
    "mqtt": "^5.0.0"  // MQTT client library
  }
}
```

---

## Hybrid Approach Architecture

### Recommended: MQTT + HTTP Dual-Transport

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React App     │────│   Express API   │────│  SQLite Database│
│  (Frontend)     │    │   (Backend)     │    │   (Persistence) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
         ┌──────────▼──────────┐   ┌─────────▼─────────┐
         │   MQTT Broker       │   │ Meshtastic Node   │
         │   (Mosquitto)       │◄──│   (HTTP API)      │
         └─────────────────────┘   └───────────────────┘
               ▲                           │
               └───────────────────────────┘
                  (Node publishes to MQTT)
```

**Receive Path (MQTT):**
1. Meshtastic node publishes mesh packets to MQTT broker
2. MeshMonitor subscribes to broker topics
3. Packets parsed and stored in database
4. Frontend receives updates via existing WebSocket/polling

**Send Path (HTTP):**
1. User sends message via frontend
2. Backend creates ToRadio protobuf message
3. HTTP POST to `/api/v1/toradio` on node
4. Node transmits to mesh
5. Acknowledgment received via MQTT subscription

**Configuration Path (HTTP):**
1. Backend requests config via HTTP `wantConfigId`
2. Node responds with config packets
3. Could arrive via MQTT or HTTP depending on implementation

---

## Use Case Analysis

### When HTTP API is Better

✅ **Single node monitoring** (MeshMonitor's primary use case)
- Simple setup, no broker needed
- Direct node access for all operations
- Lower barrier to entry for users
- Fewer moving parts = fewer failure modes

✅ **Administrative control needed**
- Configuration management
- Direct node queries
- Synchronous request/response workflows

✅ **Quick setup and testing**
- "Enter IP, done"
- No additional infrastructure
- Easy troubleshooting

### When MQTT is Better

✅ **Multi-instance monitoring**
- Multiple MeshMonitor instances watching same mesh
- Centralized data aggregation
- Reduced per-client load on node

✅ **Integration with existing infrastructure**
- Home Assistant integration
- IoT dashboards (Grafana, etc.)
- Custom automation systems

✅ **Mesh gateway scenarios**
- Monitoring multiple physical locations
- Internet-to-mesh bridging
- Mesh network analytics across regions

✅ **Resource-constrained nodes**
- Node battery life critical
- High-frequency polling causes issues
- Multiple monitoring clients

✅ **Event-driven workflows**
- Real-time alerting
- Trigger-based automation
- Low-latency notification requirements

---

## Migration Complexity Assessment

### Low Complexity (1-2 days)
- ✅ Add MQTT client to backend
- ✅ Subscribe to mesh topics
- ✅ Parse incoming packets
- ✅ Basic dual-mode operation

### Medium Complexity (3-5 days)
- ⚠️ Container infrastructure changes
- ⚠️ Mosquitto integration and configuration
- ⚠️ Connection state management (both transports)
- ⚠️ Error handling and fallback logic
- ⚠️ User documentation updates

### High Complexity (1+ weeks)
- ❌ Robust dual-transport architecture
- ❌ Graceful degradation between HTTP/MQTT
- ❌ MQTT TLS/authentication
- ❌ Testing across various node configurations
- ❌ Support for both embedded and external brokers
- ❌ User configuration UI for MQTT settings
- ❌ Migration path for existing users

### Ongoing Complexity
- 🔄 Supporting both HTTP-only and MQTT-enabled modes
- 🔄 Testing matrix explosion (HTTP, MQTT, hybrid)
- 🔄 User support for MQTT configuration issues
- 🔄 Broker maintenance and updates
- 🔄 Security considerations for exposed MQTT ports

---

## Performance Comparison

### HTTP Polling (Current)

**Typical Resource Usage:**
- Polling interval: ~1-5 seconds
- Request overhead: ~200-500 bytes per poll
- Node CPU: Minimal (handles HTTP requests)
- Bandwidth: ~10-50 KB/min depending on activity
- Latency: Polling interval (1-5 seconds)

**Pros:**
- Predictable resource usage
- No persistent connections to maintain
- Stateless and simple

**Cons:**
- Wasted polls when no new data
- Fixed latency floor equal to poll interval
- Scales linearly with number of clients

### MQTT Subscribe (Proposed)

**Typical Resource Usage:**
- Persistent connection: 1 TCP socket
- Keepalive packets: ~2 bytes every 60 seconds
- Node CPU: Minimal (publishes to broker)
- Bandwidth: Only data when events occur
- Latency: Near-instant (<100ms)

**Pros:**
- Event-driven, no wasted requests
- Sub-second latency for mesh events
- Broker handles fan-out to multiple clients efficiently

**Cons:**
- Persistent connection overhead
- Broker must be reliable (single point of failure)
- More complex connection state management

### Bandwidth Comparison Example

**Scenario**: Monitoring a mesh with ~10 nodes, 1 message/minute

**HTTP Polling** (3 second interval):
- Polls per minute: 20
- Bytes per empty poll: 200
- Bytes per minute (idle): ~4 KB
- Bytes per minute (active): ~5 KB

**MQTT Subscribe**:
- Keepalive per minute: 1 packet
- Bytes per minute (idle): ~50 bytes
- Bytes per minute (active): ~1 KB

**Savings**: ~80% bandwidth reduction during idle periods

---

## Security Considerations

### HTTP API Security
- ❌ No authentication in Meshtastic HTTP API
- ⚠️ Relies on network-level security
- ✅ Simple to proxy behind authentication layer
- ✅ HTTPS available for transport encryption

### MQTT Security
- ✅ Username/password authentication supported
- ✅ TLS encryption available
- ✅ ACL-based topic permissions
- ⚠️ Broker becomes critical security boundary
- ⚠️ Additional attack surface (broker vulnerabilities)
- ⚠️ Must secure broker management interface

### Encryption Comparison

**HTTP API + HTTPS:**
```
[MeshMonitor] --HTTPS--> [Meshtastic Node]
                          └─> Mesh (encrypted per channel PSK)
```

**MQTT + TLS:**
```
[MeshMonitor] --MQTT+TLS--> [Broker] <--MQTT+TLS-- [Meshtastic Node]
                             └─> Mesh (encrypted per channel PSK)
```

**Key Point**: MQTT adds an additional encryption hop, but also an additional trust boundary (the broker).

---

## Recommended Decision Matrix

| Scenario | Recommendation | Reasoning |
|----------|---------------|-----------|
| **Single node monitoring** | ✅ HTTP Only | Current architecture is optimal |
| **Home lab deployment** | ✅ HTTP Only | Simplicity > minor efficiency gains |
| **Multiple monitoring instances** | ⚠️ Consider MQTT | Broker reduces node load |
| **Home Assistant integration** | ✅ Add MQTT Option | HA has native MQTT support |
| **Battery-powered node** | ⚠️ Consider MQTT | Reduce polling load |
| **Mesh analytics project** | ✅ MQTT | Event-driven ideal for analytics |
| **Quick demo/testing** | ✅ HTTP Only | Faster setup |
| **Production monitoring** | ✅ HTTP (current) | Proven, stable, simple |

---

## Final Recommendation

### **DON'T Switch Entirely to MQTT**

**Reasons:**
1. ❌ Would lose administrative capabilities (config, channels)
2. ❌ Significantly increased user configuration burden
3. ❌ Still need HTTP for reliable message sending
4. ❌ Adds broker as critical infrastructure dependency
5. ✅ Current HTTP approach is working well and proven stable
6. ✅ HTTP matches MeshMonitor's use case (single-node monitoring)
7. ✅ Simplicity is a feature for open-source adoption

### **CONSIDER MQTT as Optional Enhancement**

Add MQTT support **in addition to** HTTP if these conditions emerge:

1. ✅ Users report node stability issues from polling
2. ✅ Common requests for multi-instance monitoring
3. ✅ Users want Home Assistant integration
4. ✅ Feature requests for centralized mesh monitoring
5. ✅ Commercial/enterprise use cases requiring scalability

### **Implementation Strategy If MQTT Added**

**Phase 1: Optional MQTT Receive**
- Add MQTT as optional receive path
- Keep HTTP for all sending and config
- Feature flag: `ENABLE_MQTT=true/false`
- Default to HTTP-only for backwards compatibility

**Phase 2: Hybrid Mode**
- MQTT for receiving mesh packets
- HTTP for sending and configuration
- Graceful fallback if MQTT unavailable

**Phase 3: External Broker Support**
- Support connecting to existing MQTT infrastructure
- Document Home Assistant integration
- Provide example configurations

### **Immediate Value Alternatives**

Instead of MQTT, consider these optimizations:

1. ✅ **Adaptive polling intervals**
   - Slow down when mesh inactive
   - Speed up when activity detected
   - Current implementation already does this well

2. ✅ **Connection pooling improvements**
   - Reuse HTTP connections
   - Reduce connection overhead

3. ✅ **Backpressure mechanisms**
   - Detect when node is slow/overloaded
   - Automatically reduce request rate

4. ✅ **Exponential backoff on errors**
   - Already implemented
   - Could be further tuned

5. ✅ **WebSocket for frontend updates**
   - Replace frontend polling with WebSocket
   - Backend still polls node via HTTP
   - Better user experience without changing node interaction

---

## Conclusion

The current HTTP-based architecture is **solid, appropriate, and production-ready** for MeshMonitor's primary use case: monitoring a single Meshtastic node.

MQTT offers theoretical advantages in efficiency and scalability, but adds significant complexity that isn't justified for the current scope. The HTTP API provides direct, reliable access to all node capabilities with minimal configuration burden on users.

**Recommendation**: Maintain HTTP API architecture. Revisit MQTT if specific use cases emerge that justify the additional complexity.

---

## References

- [Meshtastic MQTT Integration Docs](https://meshtastic.org/docs/software/integrations/mqtt/)
- [Meshtastic HTTP API Docs](https://meshtastic.org/docs/development/device/http-api/)
- [MQTT Module Configuration](https://meshtastic.org/docs/configuration/module/mqtt/)
- [Eclipse Mosquitto Documentation](https://mosquitto.org/documentation/)

**Document Version**: 1.0
**Date**: 2025-09-30
**Author**: Analysis for MeshMonitor project
