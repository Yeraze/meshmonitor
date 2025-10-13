# MeshMonitor System Tests

Automated deployment tests for MeshMonitor to verify both Quick Start and Production Reverse Proxy configurations.

## Overview

This directory contains automated tests that verify MeshMonitor works correctly in different deployment scenarios:

- **Quick Start**: Zero-config HTTP deployment (for local/development use)
- **Reverse Proxy**: Production HTTPS deployment behind nginx/Caddy/Traefik

## Quick Start

Run all system tests (recommended before creating/updating PRs):

```bash
./tests/system-tests.sh
```

This will:
1. Build a fresh Docker image from current code
2. Clean up any existing test volumes
3. Run the Quick Start deployment test
4. Run the Reverse Proxy deployment test
5. Report overall results

## Individual Test Scripts

### Quick Start Test

Tests the minimal zero-config deployment:

```bash
./tests/test-quick-start.sh
```

**What it tests:**
- Container starts without SESSION_SECRET
- Container starts without COOKIE_SECURE
- HTTP access works (no HSTS headers)
- Admin user created automatically with default credentials
- Login works with default credentials (admin/changeme)
- Session cookies work over HTTP
- Meshtastic node connection (>3 channels, >100 nodes)
- Direct message sending to test node

**Configuration:**
- Node IP: 192.168.5.106
- Port: 8083
- Protocol: HTTP

### Reverse Proxy Test

Tests production deployment behind HTTPS reverse proxy:

```bash
./tests/test-reverse-proxy.sh
```

**What it tests:**
- Container runs in production mode
- Trust proxy configuration
- HTTPS-ready (COOKIE_SECURE=true)
- Session cookies have Secure flag
- CSRF token works via HTTPS
- Login works via HTTPS
- Authenticated sessions work
- CORS configured for allowed origin
- Meshtastic node connection
- Direct message sending and receiving

**Configuration:**
- Node IP: 192.168.5.106
- Port: 8084 (internal), HTTPS via meshdev.yeraze.online
- Protocol: HTTPS
- Domain: https://meshdev.yeraze.online

## Test Results

Each test script reports:
- ✓ PASS: Test succeeded
- ✗ FAIL: Test failed (critical - will exit 1)
- ⚠ WARN: Non-critical issue (informational only)
- ⚠ INFO: Informational message

## Development Workflow

### Before Creating a PR

Always run the system tests:

```bash
./tests/system-tests.sh
```

This ensures both deployment configurations work correctly with your changes.

### Before Updating a PR

After making changes based on review feedback, run:

```bash
./tests/system-tests.sh
```

This verifies your updates haven't broken existing functionality.

### Testing Individual Changes

If you're working on a specific deployment scenario:

```bash
# Test only Quick Start changes
./tests/test-quick-start.sh

# Test only Reverse Proxy changes
./tests/test-reverse-proxy.sh
```

## Test Details

### Node Connection Verification

Both tests verify Meshtastic node connectivity by checking:
- Channels: Must have >3 channels synced
- Nodes: Must have >100 nodes in database

Tests wait up to 30 seconds for the node to connect and sync data.

### Messaging Tests

Both tests send a direct message to test node:
- Target: Yeraze Station G2 (!a2e4ff4c)
- Quick Start message: "Test in Quick Start"
- Reverse Proxy message: "Test in Reverse Proxy"

Tests wait up to 60 seconds for a response. If no response is received, a warning is shown but the test still passes (node may be offline).

## Cleanup

All tests automatically clean up after themselves:
- Stop and remove test containers
- Remove test volumes
- Remove temporary files and cookies

The `system-tests.sh` script also performs cleanup before running tests to ensure a fresh environment.

## Troubleshooting

### Tests Failing

1. **Node not connecting**: Verify the Meshtastic node at 192.168.5.106 is accessible
2. **Port conflicts**: Check if ports 8083/8084 are already in use
3. **Docker issues**: Ensure Docker daemon is running and you have permissions
4. **Image build fails**: Check for build errors in the output

### Running Individual Tests

If system tests fail, run individual tests to isolate the issue:

```bash
# Test Quick Start only
./tests/test-quick-start.sh

# Test Reverse Proxy only
./tests/test-reverse-proxy.sh
```

### Manual Cleanup

If tests are interrupted and don't clean up properly:

```bash
# Stop all test containers
docker compose -f docker-compose.quick-start-test.yml down -v
docker compose -f docker-compose.reverse-proxy-test.yml down -v

# Remove test volumes
docker volume rm meshmonitor_meshmonitor-quick-start-test-data
docker volume rm meshmonitor_meshmonitor-reverse-proxy-test-data

# Remove temporary files
rm -f /tmp/meshmonitor-cookies.txt
rm -f /tmp/meshmonitor-reverse-proxy-cookies.txt
```

## CI/CD Integration

These tests are designed to run locally on the development machine. For CI/CD integration:

- Tests require access to physical Meshtastic node (192.168.5.106)
- Tests require access to production reverse proxy domain
- Consider creating mock versions for CI pipelines

## Requirements

- Docker and Docker Compose
- curl
- grep
- Access to Meshtastic node at 192.168.5.106
- Access to meshdev.yeraze.online domain (for reverse proxy test)
