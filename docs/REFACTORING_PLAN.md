# MeshMonitor Refactoring Plan

## Overview
This document outlines the strategy for refactoring MeshMonitor to improve maintainability, reduce file sizes, and address feedback from PR #118.

## Current Issues
1. **Large files exceeding token limits**:
   - App.tsx: 3415 lines
   - meshtasticManager.ts: 3323 lines
   - database.ts: 1489 lines
   - server.ts: 1385 lines
   - ConfigurationTab.tsx: 1201 lines

2. **Excessive console logging**: 591 console statements throughout codebase

3. **Mixed UI patterns**: window.confirm/alert vs toast notifications

4. **Lack of error boundaries**: No protection against component crashes

## Refactoring Strategy

### Phase 1: ConfigurationTab Modularization (PRIORITY 1)
**Goal**: Break 1201-line component into focused, reusable sections

**New Structure**:
```
src/components/configuration/
├── ConfigurationTab.tsx (main container, ~150 lines)
├── NodeIdentitySection.tsx (names, role, broadcast interval)
├── LoRaConfigSection.tsx (modem preset, region, hop limit)
├── PositionConfigSection.tsx (GPS coordinates, fixed position)
├── MQTTConfigSection.tsx (server, credentials, topic)
├── hooks/
│   ├── useDeviceConfig.ts (config loading/saving logic)
│   └── useConfigValidation.ts (validation logic)
└── types.ts (shared types)
```

**Benefits**:
- Each section < 300 lines
- Better testability
- Easier to maintain
- Reusable hooks

### Phase 2: App.tsx Decomposition (PRIORITY 2)
**Goal**: Split 3415-line monolith into manageable pieces

**New Structure**:
```
src/components/
├── App.tsx (main shell, ~200 lines)
├── map/
│   ├── MeshMap.tsx (Leaflet map component)
│   ├── NodeMarkers.tsx (node marker rendering)
│   ├── NodePopup.tsx (extracted from inline JSX)
│   └── hooks/
│       ├── useMapState.ts (map zoom, center, bounds)
│       └── useNodeFiltering.ts (search, filters)
├── context/
│   ├── NodesContext.tsx (nodes state management)
│   ├── MessagesContext.tsx (messages state management)
│   └── DeviceContext.tsx (device config state)
└── hooks/
    ├── useWebSocket.ts (WebSocket connection logic)
    └── usePolling.ts (API polling logic)
```

**Benefits**:
- Separation of concerns
- Context-based state management
- Reusable hooks
- Better code organization

### Phase 3: Backend Modularization (PRIORITY 3)
**Goal**: Split backend services into focused modules

**meshtasticManager.ts split**:
```
src/server/meshtastic/
├── MeshtasticManager.ts (orchestrator, ~500 lines)
├── ConnectionManager.ts (TCP/Serial connection handling)
├── MessageHandler.ts (message processing)
├── PositionTracker.ts (position updates)
├── TelemetryTracker.ts (telemetry processing)
└── AdminCommands.ts (admin message handling)
```

**server.ts split**:
```
src/server/
├── server.ts (Express setup, ~200 lines)
├── routes/
│   ├── nodes.ts (node endpoints)
│   ├── messages.ts (message endpoints)
│   ├── config.ts (configuration endpoints)
│   ├── telemetry.ts (telemetry endpoints)
│   └── admin.ts (admin endpoints)
└── middleware/
    ├── errorHandler.ts
    └── validation.ts
```

### Phase 4: Logging System (PRIORITY 4)
**Goal**: Replace console.* with proper logging system

**Implementation**:
```typescript
// src/utils/logger.ts
const isDev = process.env.NODE_ENV === 'development';

export const logger = {
  debug: (...args: any[]) => isDev && console.log('[DEBUG]', ...args),
  info: (...args: any[]) => console.log('[INFO]', ...args),
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args)
};
```

**Strategy**:
- Replace all `console.log` → `logger.debug` (disabled in production)
- Replace `console.warn` → `logger.warn`
- Replace `console.error` → `logger.error`
- Keep critical logs only

### Phase 5: UI Consistency (PRIORITY 5)
**Goal**: Replace browser dialogs with custom components

**New Components**:
```
src/components/ui/
├── Modal.tsx (base modal component)
├── ConfirmDialog.tsx (replaces window.confirm)
├── AlertDialog.tsx (replaces window.alert)
└── hooks/
    ├── useModal.ts
    └── useConfirm.ts
```

**Usage**:
```typescript
// Old
if (window.confirm('Are you sure?')) { ... }

// New
const { confirm } = useConfirm();
if (await confirm('Are you sure?')) { ... }
```

### Phase 6: Error Boundaries
**Goal**: Add error protection around major sections

**Implementation**:
```
src/components/ErrorBoundary.tsx
src/components/SectionErrorBoundary.tsx
```

**Wrap**:
- ConfigurationTab sections
- Map component
- Tab components

## Success Metrics
- All files < 500 lines (stretch goal)
- Console statements reduced by 90%
- Consistent UI patterns throughout
- Zero unhandled errors in production
- Improved bundle size

## Timeline
- Phase 1: 1 PR (ConfigurationTab)
- Phase 2: 1 PR (App.tsx)
- Phase 3: 2 PRs (backend split)
- Phase 4: 1 PR (logging)
- Phase 5: 1 PR (UI consistency)
- Phase 6: 1 PR (error boundaries)

Total: 7 PRs over ~2 weeks

## Notes
- Each phase should be a separate PR
- Maintain backward compatibility
- Keep tests passing
- No feature changes - refactoring only
