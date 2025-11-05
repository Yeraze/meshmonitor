# TODO List

## Current Sprint

### Configuration Improvements
- [x] Add localhost to default ALLOWED_ORIGINS configuration (#458)
  - Changed default from empty array to `['http://localhost:8080', 'http://localhost:3001']`
  - Improves out-of-box experience for local development and testing
  - Still requires explicit configuration for production deployments
  - Files: src/server/config/environment.ts:282-288, .env.example, docs/configuration/index.md:81

### Bug Fixes
- [x] Fix traceroute visualization not updating when clicking different nodes
  - Issue: NodesTab memo comparison only checked null vs non-null for traceroutes
  - Fixed by adding reference comparison to detect when traceroute content changes (src/components/NodesTab.tsx:1110-1114)

## Version 2.13.3 Release Tasks

- [x] Update version in package.json to 2.13.3
- [x] Update version in Helm chart to 2.13.3
- [x] Regenerate package-lock.json
- [x] Update documentation with recent changes

## Completed Tasks

### Mobile UI Improvements

- [x] Add unread message indicator to dropdown on Messages page
- [x] Reflow Security page rows to 2 lines for mobile display
- [x] Break Device Backup modal onto 2 lines for mobile compatibility

### Virtual Node Enhancements

- [x] Add Virtual Node status block to Info page showing connection status and number of connected clients
- [x] Display IP addresses of connected Virtual Node clients when authenticated
- [x] Log Virtual Node connections in Audit system
- [x] Fix message status updates for messages sent through Virtual Node (currently showing as Pending despite receiving Ack's)
  - Added `virtualNodeRequestId` to ProcessingContext to preserve packet ID
  - Modified `processTextMessageProtobuf` to accept context parameter
  - Modified `processMeshPacket` to accept and pass context parameter
  - Updated call to `processTextMessageProtobuf` to pass context through (src/server/meshtasticManager.ts:1046)
  - Fixed context parameter passing in `processIncomingData` to `processMeshPacket` (src/server/meshtasticManager.ts:527)
  - Messages now store `requestId`, `wantAck`, and `deliveryState` for Virtual Node messages
- [x] Secure Virtual Node status endpoint to require authentication (src/server/server.ts:899)
