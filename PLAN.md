# Plan: StatusMessage & TrafficManagement Module Integration

## Research Findings

### StatusMessage Module
- **Protobuf added**: Jan 17, 2026 (protobufs PR #835)
- **Firmware PR**: [#9351](https://github.com/meshtastic/firmware/pull/9351), merged into alpha 2.7.19
- **Purpose**: Allows nodes to set a status message (separate from long name) that is periodically rebroadcast (~twice daily)
- **Config fields**: Only one field
  - `node_status` (string, max 80 chars) - the status text
- **Proto field**: `ModuleConfig.statusmessage` (field 14), `ModuleConfigType.STATUSMESSAGE_CONFIG = 13`
- **Notable**: Does NOT require device reboot on config change

### TrafficManagement Module
- **Protobuf added**: Jan 19, 2026 (commit e2daf8d in protobufs repo)
- **Firmware status**: Protobuf definitions exist, but **not yet released** in any stable or alpha firmware. No firmware implementation PR found.
- **Purpose**: Mesh traffic optimization - position dedup, rate limiting, NodeInfo caching, hop exhaustion
- **Config fields** (14 fields):
  - `enabled` (bool) - master enable
  - `position_dedup_enabled` (bool) - drop redundant position broadcasts
  - `position_precision_bits` (uint32, 0-32) - precision for position dedup
  - `position_min_interval_secs` (uint32) - min interval between position updates from same node
  - `nodeinfo_direct_response` (bool) - respond to NodeInfo requests from local cache
  - `nodeinfo_direct_response_max_hops` (uint32) - min hop distance before responding
  - `rate_limit_enabled` (bool) - per-node rate limiting
  - `rate_limit_window_secs` (uint32) - time window for rate limiting
  - `rate_limit_max_packets` (uint32) - max packets per window
  - `drop_unknown_enabled` (bool) - drop unknown/undecryptable packets
  - `unknown_packet_threshold` (uint32) - threshold before dropping
  - `exhaust_hop_telemetry` (bool) - set hop_limit=0 for relayed telemetry
  - `exhaust_hop_position` (bool) - set hop_limit=0 for relayed position
  - `router_preserve_hops` (bool) - preserve hops for router-to-router traffic
- **Proto field**: `ModuleConfig.traffic_management` (field 15), `ModuleConfigType.TRAFFICMANAGEMENT_CONFIG = 14`

### Current Codebase State
| Area | StatusMessage | TrafficManagement |
|------|--------------|-------------------|
| `requestAllModuleConfigs()` | Requests type 13 | Requests type 14 |
| `processAdminMessage()` | Stores via generic key merge | Stores via generic key merge |
| `createSetModuleConfigMessageGeneric()` | **MISSING** from configFieldMap | **MISSING** from configFieldMap |
| `server.ts` load-config maps | Partially present (`statusmessage`) | **MISSING** |
| `server.ts` switch cases | `case 'statusmessage'` exists | **MISSING** |
| `server.ts` remote configTypeMap | `statusmessage: type 13` exists | **MISSING** |
| `getCurrentConfig()` Proto3 defaults | Not applied | Not applied |
| UI Components | None | None |
| Admin Commands Tab | None | None |

### Firmware Version Detection
- Existing pattern: `parseFirmwareVersion()` + `supportsFavorites()` (checks >= 2.7.0)
- `localNodeInfo.firmwareVersion` is available via `getCurrentConfig()` response
- Remote nodes get firmware via `getDeviceMetadataResponse`

---

## Implementation Plan

### Approach: Response-Based Detection

Rather than hard-coding firmware version thresholds (fragile, since TrafficManagement isn't even released yet), we detect support by checking whether the node **returned a config response** for each module type. If the node doesn't understand the module, it simply won't respond to the config request (the config key will be absent from `actualModuleConfig`).

The `getCurrentConfig()` response already includes whatever module configs were received. We add a `supportedModules` metadata field to indicate which optional modules the connected node supports.

### Phase 1: Backend - Wire Up Both Modules

#### 1a. `protobufService.ts` - Add to configFieldMap
Add mappings in `createSetModuleConfigMessageGeneric()`:
```
'statusmessage': 'statusmessage',
'trafficmanagement': 'trafficManagement'
```

#### 1b. `server.ts` - Complete the config maps
Add `trafficmanagement` to all config maps where `statusmessage` already exists:
- Module config map in the load-config needsRequest check (~line 6113)
- The `case` statement for raw module configs (~line 6315)
- The moduleConfigMap in the case body (~line 6329)
- The remote configTypeMap (~line 6369): `'trafficmanagement': { type: 14, isModule: true }`

#### 1c. `meshtasticManager.ts` - Remote config polling maps
Add entries to the `moduleConfigMap` in `requestRemoteConfig()`:
- `14: 'trafficManagement'` (alongside existing `13: 'statusmessage'`)

#### 1d. `getCurrentConfig()` - Add Proto3 defaults
Apply Proto3 defaults for both new modules (like existing mqtt/neighborInfo/telemetry pattern):
- StatusMessage: `nodeStatus` defaults to `''`
- TrafficManagement: all booleans default to `false`, all uint32s default to `0`

#### 1e. `getCurrentConfig()` - Add supported modules metadata
Add a `supportedModules` object to the return value:
```typescript
return {
  deviceConfig,
  moduleConfig,
  localNodeInfo: this.localNodeInfo,
  supportedModules: {
    statusmessage: !!moduleConfig.statusmessage,
    trafficManagement: !!moduleConfig.trafficManagement
  }
};
```
This tells the frontend which optional modules the connected node actually supports.

### Phase 2: Frontend - Configuration Tab (Local Node)

#### 2a. New Component: `StatusMessageConfigSection.tsx`
Simple section with:
- Text input for `nodeStatus` (max 80 chars, with character counter)
- Save button
Pattern: follow existing simple config sections like `PaxcounterConfigSection.tsx`

#### 2b. New Component: `TrafficManagementConfigSection.tsx`
Grouped section with:
- Master enable toggle
- **Position Deduplication** group: enable toggle, precision bits (slider/number 0-32), min interval seconds
- **NodeInfo Direct Response** group: enable toggle, max hops (number)
- **Rate Limiting** group: enable toggle, window seconds, max packets
- **Unknown Packet Dropping** group: enable toggle, threshold count
- **Hop Exhaustion** group: exhaust_hop_telemetry toggle, exhaust_hop_position toggle, router_preserve_hops toggle

#### 2c. `ConfigurationTab.tsx` - Add Both Sections
- Add state variables for both modules' config fields
- Load from `config.moduleConfig.statusmessage` and `config.moduleConfig.trafficManagement`
- Wire save handlers through `apiService.setModuleConfig()`
- **Conditional rendering**: Check `supportedModules` from config response. If a module is not supported, render the section as disabled/collapsed with a message like "This module is not supported by the connected node's firmware"

### Phase 3: Frontend - Admin Commands Tab (Remote Administration)

#### 3a. Update `ModuleConfigurationSection.tsx`
Add StatusMessage and TrafficManagement sections to the existing component, following the MQTT/NeighborInfo/Telemetry pattern.

#### 3b. Update `useAdminCommandsState.ts`
Add state fields and reducer actions for both new module configs.

#### 3c. Update `AdminCommandsTab.tsx`
- Add `statusmessage` and `trafficmanagement` to the `handleLoadAllConfigs()` sequence
- Add save command mappings for both modules
- Apply the same disabled/unsupported logic based on whether config was returned

### Phase 4: API Service Updates

#### 4a. `apiService.ts` (frontend)
Both modules should already work via the existing `setModuleConfig(moduleType, config)` generic method, but verify and add any needed type-specific methods.

### Unsupported Module UI Pattern

When a module is not supported (node didn't return config for it):
- Section header still visible with "Unsupported by device firmware" message
- Entire section disabled (grayed out inputs, save button disabled)
- Show known firmware version requirement: "Requires firmware version X or greater"
  - StatusMessage: "Requires firmware version 2.7.19 or greater"
  - TrafficManagement: "Not yet available in any firmware release"
- No firmware version gating logic - purely response-based detection
- Use the node's known firmware version in the message for context

---

## Files to Modify

### Backend
1. `src/server/protobufService.ts` - Add configFieldMap entries
2. `src/server/server.ts` - Complete config maps and switch cases
3. `src/server/meshtasticManager.ts` - Remote config maps + getCurrentConfig() changes

### Frontend (New)
4. `src/components/configuration/StatusMessageConfigSection.tsx` - New component
5. `src/components/configuration/TrafficManagementConfigSection.tsx` - New component

### Frontend (Modify)
6. `src/components/ConfigurationTab.tsx` - Wire in new sections
7. `src/components/admin-commands/ModuleConfigurationSection.tsx` - Add to remote admin
8. `src/components/admin-commands/useAdminCommandsState.ts` - Add state/actions
9. `src/components/AdminCommandsTab.tsx` - Wire in load/save commands

### Tests
10. Tests for new config sections
11. Update existing config tests that enumerate module types

---

## Decisions Made

1. **Unsupported modules**: Shown disabled (not hidden) with "Unsupported by device firmware" message + firmware version guidance
2. **Detection**: Response-based only, no firmware version gating logic
3. **Firmware version display**: StatusMessage = "Requires firmware 2.7.19+", TrafficManagement = "Not yet available in any firmware release"

## Open Question (remaining)

1. **TrafficManagement field naming**: Need to verify `trafficManagement` is the actual key in decoded protobuf responses (protobufjs camelCases `traffic_management`).
