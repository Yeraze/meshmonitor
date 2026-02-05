# Scripts

## meshcore-bridge.py

A long-lived Python bridge process that communicates with MeshCore devices via the `meshcore` Python library. The Node.js server spawns this bridge and sends JSON commands over stdin, receiving JSON responses over stdout.

### Requirements

- Python 3.8+
- `meshcore` library: `pip install meshcore`

### Protocol

Commands are sent as single-line JSON objects:
```json
# Serial connection
{"id": "1", "cmd": "connect", "type": "serial", "port": "/dev/ttyACM0", "baud": 115200}

# TCP connection
{"id": "1", "cmd": "connect", "type": "tcp", "host": "192.168.1.100", "tcp_port": 4403}
```

Responses are single-line JSON:
```json
{"id": "1", "success": true, "data": {"connected": true, "self_info": {...}}}
```

### Supported Commands

- `connect` - Connect to a MeshCore device (serial port)
- `disconnect` - Disconnect from device
- `get_self_info` - Get local node information
- `get_contacts` - Get known contacts list
- `send_message` - Send a message (broadcast or direct)
- `send_advert` - Send an advertisement packet
- `login` - Login to a remote node for admin access
- `get_status` - Get status from a remote node
- `set_name` - Set device name
- `set_radio` - Set radio parameters (freq, bw, sf, cr)
- `shutdown` - Gracefully terminate the bridge

---

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
