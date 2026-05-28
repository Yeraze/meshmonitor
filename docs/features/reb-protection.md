# REB / GPS Spoofing Protection

MeshMonitor includes defenses against GPS jamming and spoofing attacks (REB — radio-electronic warfare). These protect the mesh map, telemetry graphs, and message timestamps from being corrupted by nodes operating under EW influence.

## Background

Meshtastic nodes rely on GPS for time synchronization and position reporting. Under GPS jamming or spoofing:

- A node's `rxTime` field may report dates in 1970, far future, or hours off from real time
- Position coordinates can be falsified, placing nodes in wrong locations
- Garbage telemetry (battery, sensor readings) can pollute history graphs

## Protections Implemented

### 1. `sanitizeRxTime` — Timestamp Validation

All incoming packet timestamps are validated against the server clock before storage. A packet's `rxTime` is accepted only if it passes these checks:

| Check | Threshold | Action on failure |
|-------|-----------|-------------------|
| Missing / zero | — | Use server time (silent, normal for some packets) |
| Before 2020-01-01 | Unix < 1577836800 | Use server time + log `[REB-DETECT]` warning |
| More than 1 year in future | > now + 365 days | Use server time + log `[REB-DETECT]` warning |
| Offset from server clock | > ±3600 s (1 hour) | Use server time + log `[REB-DETECT]` warning |

The original node time is preserved in packet-log metadata for diagnostics but is never used for sorting or display.

**Log example:**
```
⚠️ [REB-DETECT] Node !aabbccdd: rxTime=0 is before 2020-01-01
   (GPS epoch reset or spoof). Replacing with server time.

⚠️ [REB-DETECT] Node !aabbccdd: rxTime offset +7200s exceeds ±3600s threshold.
   node_time=1970-01-01T00:00:00.000Z, server=2025-05-28T12:00:00.000Z.
   Replacing with server time.
```

### 2. `telemetryTrustedNodes` — Position & Telemetry Allowlist

When a mesh includes nodes that may be under EW influence, you can restrict which nodes are allowed to update positions and telemetry data. Nodes not on the list have their position and telemetry silently dropped — text messages and routing are **not** affected.

**Log example:**
```
🛡️ [REB-FILTER] Position from !aabbccdd rejected — not in telemetryTrustedNodes list
🛡️ [REB-FILTER] Telemetry from !aabbccdd rejected — not in telemetryTrustedNodes list
```

#### Configuration

Set **Settings → telemetryTrustedNodes** to a comma-separated list of node IDs:

```
!aabbccdd, !11223344, !deadbeef
```

- **Empty (default):** all nodes trusted — existing behaviour, no performance impact
- **Non-empty:** only listed nodes write position and telemetry; all others are filtered

The allowlist is cached for 60 seconds to avoid a database read on every incoming packet.

## Clock Offset Telemetry Integration

The time-offset telemetry widget (which tracks how far each node's clock drifts) also benefits from this protection: only offsets within ±1 hour are recorded as samples, eliminating GPS-spoof-induced spikes from the time-drift graph.

## Monitoring

Filter MeshMonitor server logs for these prefixes:

| Prefix | Meaning |
|--------|---------|
| `[REB-DETECT]` | Timestamp rejected, server time substituted |
| `[REB-FILTER]` | Position/telemetry dropped (trusted-node list active) |

## Related

- [Security Overview](security) — authentication, permissions, audit log
- [Automation](automation) — auto-key management for PKI repair
