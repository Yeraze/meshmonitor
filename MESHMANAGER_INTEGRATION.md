# MeshManager Integration

This branch (`feature/meshmanager-integration`) implements the aggregation endpoints required by MeshManager to collect and aggregate data from multiple MeshMonitor instances.

## Implemented Endpoints

All endpoints are available under `/api/aggregate/*` and `/api/instance/*`:

### Aggregation Endpoints

1. **GET /api/aggregate/summary**
   - Returns aggregated summary: node count, message count, channel count, last update timestamp
   - Response: `{ nodeCount, messageCount, channelCount, lastUpdate }`

2. **GET /api/aggregate/nodes**
   - Returns all nodes with full details including position, telemetry, and metadata
   - Response: `Array<{ id, name, position, telemetry, lastSeen, ... }>`

3. **GET /api/aggregate/messages**
   - Returns messages with pagination and filtering
   - Query params: `limit`, `offset`, `channel`, `since`, `node`
   - Response: `Array<{ id, from, to, text, channel, timestamp, ... }>`

4. **GET /api/aggregate/channels**
   - Returns all configured channels
   - Response: `Array<{ index, name, role, uplinkEnabled, downlinkEnabled, ... }>`

5. **GET /api/aggregate/stats**
   - Returns network statistics including message rate, uptime, etc.
   - Response: `{ totalMessages, totalNodes, channelCount, uptime, messageRate, ... }`

### Instance Metadata

6. **GET /api/instance/metadata**
   - Returns instance identification and metadata for health checks
   - Response: `{ version, meshmonitorVersion, instanceId, capabilities }`

## Authentication

All endpoints support:
- **Session-based authentication** (if user is logged in)
- **API key authentication** via:
  - `Authorization: Bearer <token>` header
  - `X-API-Key: <token>` header

If no authentication is provided, endpoints will use the anonymous user for permission checks.

## CORS

CORS is configured globally in MeshMonitor. The aggregation endpoints inherit this configuration. In development, `http://localhost:5173` (MeshManager's default port) is automatically allowed.

## Files Added

- `src/server/routes/aggregateRoutes.ts` - Aggregation endpoint implementations
- `src/server/routes/instanceRoutes.ts` - Instance metadata endpoint

## Files Modified

- `src/server/server.ts` - Added route registrations for aggregation and instance endpoints

## Testing

To test the endpoints:

```bash
# Test summary endpoint
curl http://localhost:3001/api/aggregate/summary

# Test nodes endpoint
curl http://localhost:3001/api/aggregate/nodes

# Test messages endpoint
curl "http://localhost:3001/api/aggregate/messages?limit=10"

# Test channels endpoint
curl http://localhost:3001/api/aggregate/channels

# Test stats endpoint
curl http://localhost:3001/api/aggregate/stats

# Test instance metadata
curl http://localhost:3001/api/instance/metadata
```

With API key:
```bash
curl -H "Authorization: Bearer <your-api-token>" http://localhost:3001/api/aggregate/summary
```

## Integration with MeshManager

1. MeshManager can now add MeshMonitor instances running this branch
2. Health checks will use `/api/instance/metadata`
3. Data aggregation will use all `/api/aggregate/*` endpoints
4. Both applications can run simultaneously for testing

## Next Steps

1. Test endpoints with MeshManager locally
2. Submit PR to MeshMonitor upstream
3. After merge, tag new MeshMonitor release
4. Update MeshManager to require minimum MeshMonitor version

## Notes

- All endpoints follow MeshMonitor's existing patterns and error handling
- Timestamps are converted to ISO 8601 format for consistency
- Pagination and filtering are supported where applicable
- Backward compatible - no breaking changes to existing functionality

