# Scripts

# Test Utilities

## insert-test-node.js

This script inserts an artificial test node with a low-entropy encryption key into the database. This is useful for testing and developing the Security feature.

### Usage

```bash
node scripts/insert-test-node.js
```

### What it does

1. Creates a test node with node number `999999999` and node ID `!testnode`
2. Assigns it a public key with a simple repeating pattern (32 bytes of `0x01`)
3. This key's hash (`72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793`) is included in the low-entropy detection list
4. The Security scanner will flag this node as having a low-entropy key

### Verification

After inserting the test node:

1. Access MeshMonitor at http://localhost:8080
2. Navigate to the Security page
3. Trigger a manual security scan (or wait for the scheduled scan)
4. The test node should appear in the list of security issues with "Known low-entropy key detected"

### Cleanup

To remove the test node:

```bash
node -e "const db = require('better-sqlite3')('data/meshmonitor.db'); db.prepare('DELETE FROM nodes WHERE nodeNum = 999999999').run(); console.log('Test node removed'); db.close();"
```

## Notes

- The test key pattern (all `0x01` bytes) is deliberately weak to simulate keys generated with insufficient randomness
- This is only for development and testing purposes
- The hash of this test key is added to `src/services/lowEntropyKeyService.ts` in the `LOW_ENTROPY_HASHES` array

---

## setup-dev-config.sh

Seeds a fresh MeshMonitor instance with default dev/test configuration. Run this after nuking the database volume to restore a working test setup.

### What it configures

- **Two sources**: Sentry (192.168.5.106:4403) and Sandbox (host.docker.internal:4404)
- **Auto-acknowledge**: Enabled on each source's gauntlet channel with test regex
- **Packet monitor**: Enabled globally and per-source

### Usage

```bash
# After starting the dev container:
./scripts/setup-dev-config.sh

# With custom source hosts:
SOURCE1_HOST=192.168.1.100 SOURCE2_HOST=192.168.1.200 ./scripts/setup-dev-config.sh

# Skip source creation (just configure settings for existing sources):
SKIP_SOURCES=true ./scripts/setup-dev-config.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE_URL` | `http://localhost:8081/meshmonitor` | MeshMonitor base URL |
| `API_USER` | `admin` | Login username |
| `API_PASS` | `changeme1` | Login password |
| `SOURCE1_NAME` | `Sentry` | Source 1 display name |
| `SOURCE1_HOST` | `192.168.5.106` | Source 1 TCP host |
| `SOURCE1_PORT` | `4403` | Source 1 TCP port |
| `SOURCE1_GAUNTLET` | `7` | Source 1 gauntlet channel index |
| `SOURCE2_NAME` | `Sandbox` | Source 2 display name |
| `SOURCE2_HOST` | `192.168.4.21` | Source 2 TCP host |
| `SOURCE2_PORT` | `4403` | Source 2 TCP port |
| `SOURCE2_GAUNTLET` | `2` | Source 2 gauntlet channel index |
| `SKIP_SOURCES` | `false` | Skip source creation, only configure settings |
