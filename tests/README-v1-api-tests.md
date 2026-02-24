# V1 Public API Test Suite

This document describes the test coverage for the MeshMonitor V1 Public API.

## Test Files

### Unit Tests (`src/server/routes/v1/v1-api.test.ts`)

Comprehensive unit tests for all V1 API endpoints using Vitest and Supertest.

**Test Coverage:**
- Authentication
  - Rejects requests without API token
  - Rejects requests with invalid API token
  - Accepts requests with valid API token

- API Root (`GET /api/v1/`)
  - Returns API version info
  - Lists all available endpoints

- Nodes API (`GET /api/v1/nodes`)
  - Returns list of nodes with standard response format
  - Includes known test node ("Yeraze Station G2")
  - Returns specific node by ID
  - Returns 404 for non-existent nodes

- Messages API (`GET /api/v1/messages`)
  - Returns messages with pagination
  - Respects offset and limit parameters

- Telemetry API (`GET /api/v1/telemetry`)
  - Returns telemetry data array

- Traceroutes API (`GET /api/v1/traceroutes`)
  - Returns traceroute data array

- Packets API (`GET /api/v1/packets`)
  - Returns packet log data with pagination
  - Supports filtering by portnum
  - Returns specific packet by ID
  - Returns 404 for non-existent packets

- Response Format Consistency
  - All list endpoints have consistent structure (success, data, count)
  - All error responses have consistent structure (success, error, message)

**Running Unit Tests:**
```bash
npm test src/server/routes/v1/v1-api.test.ts
```

### System Tests (`tests/test-v1-api.sh`)

Integration test that runs against a live Quick Start container.

**Test Flow:**
1. Setup: Spins up Quick Start container or uses existing deployment
2. Login to web interface
3. Generate API token via web UI
4. Test all V1 API endpoints with real data
5. Verify authentication enforcement
6. Verify response format consistency
7. Teardown (optional with KEEP_ALIVE=true)

**Test Coverage:**
- API Root endpoint returns version info
- Nodes list endpoint returns data
- Node count validation (>= 10 nodes)
- Known node validation ("Yeraze Station G2" exists)
- Specific node retrieval by ID
- Messages endpoint with pagination
- Telemetry endpoint
- Traceroutes endpoint
- Network topology endpoint
- Packets endpoint with filtering
- Specific packet retrieval by ID
- Authentication rejection without token
- Authentication rejection with invalid token
- Response format consistency across all endpoints

**Running System Tests:**
```bash
# Run against local Quick Start container (spins up automatically)
./tests/test-v1-api.sh

# Run against existing deployment
TEST_EXTERNAL_APP_URL=http://localhost:3001 ./tests/test-v1-api.sh

# Keep container alive after test
KEEP_ALIVE=true ./tests/test-v1-api.sh

# Use custom node IP
TEST_NODE_IP=192.168.1.100 ./tests/test-v1-api.sh
```

**Requirements:**
- Docker and docker compose
- `jq` for JSON parsing
- `curl` for HTTP requests
- Access to Meshtastic node (default: 192.168.5.106)

## Integration with CI/CD

The V1 API system test is integrated into the main system test suite (`tests/system-tests.sh`).

**Running Full System Tests:**
```bash
./tests/system-tests.sh
```

This will run all system tests including:
- Configuration Import
- Quick Start (including security tests)
- Reverse Proxy
- Reverse Proxy + OIDC
- Virtual Node CLI
- Backup & Restore
- **V1 Public API** (new!)

## Test Data Requirements

The V1 API tests expect:
- At least 10 nodes in the mesh network
- A node with short name containing "YERG2" or "YerG2" or long name "Yeraze Station G2"
- Some telemetry data
- Some message data
- Some packet log data

## Known Limitations

- Unit tests create mock data and may not catch all integration issues
- System tests require access to a real Meshtastic node
- Some tests check for minimum data counts (e.g., >= 10 nodes) which may fail on smaller networks
- Tests assume the default admin credentials (admin/admin) for Quick Start deployment

## Future Enhancements

- Add tests for v1 API error conditions
- Add tests for v1 API rate limiting (if implemented)
- Add tests for v1 API versioning
- Add performance tests for large datasets
- Add tests for concurrent API requests
