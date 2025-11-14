# Auto Responder Script Examples

This directory contains example scripts for use with MeshMonitor's Auto Responder feature.

## Using Scripts with Auto Responder

1. **Copy scripts to the container's /data/scripts directory:**
   ```bash
   docker cp hello.js meshmonitor:/data/scripts/
   docker cp weather.py meshmonitor:/data/scripts/
   docker cp info.sh meshmonitor:/data/scripts/
   ```

2. **Make scripts executable (if needed):**
   ```bash
   docker exec meshmonitor chmod +x /data/scripts/*.js
   docker exec meshmonitor chmod +x /data/scripts/*.py
   docker exec meshmonitor chmod +x /data/scripts/*.sh
   ```

3. **Configure Auto Responder in MeshMonitor UI:**
   - Navigate to Settings → Automation → Auto Responder
   - Add a new trigger:
     - Trigger: `hello {name}` (or any pattern)
     - Type: **Script**
     - Response: `/data/scripts/hello.js` (or your script path)

## Script Requirements

Scripts must:
1. Be located in `/data/scripts/` directory
2. Have a supported extension: `.js`, `.mjs`, `.py`, or `.sh`
3. Output valid JSON to stdout with a `response` field
4. Complete within 10 seconds (timeout)

## Environment Variables

All scripts receive these environment variables:

- `MESSAGE`: Full message text received
- `FROM_NODE`: Sender's node number
- `PACKET_ID`: Message packet ID
- `TRIGGER`: The trigger pattern that matched
- `PARAM_*`: Extracted parameters from trigger pattern (e.g., `PARAM_name`, `PARAM_location`)

## Output Format

Scripts must print JSON to stdout:

```json
{
  "response": "Your response text here (max 200 chars)"
}
```

Optional (for future use):
```json
{
  "response": "Your response text",
  "actions": {
    "notify": false,
    "log": true
  }
}
```

## Example Scripts

### hello.js (Node.js)
Simple greeting script that uses extracted parameters.

**Trigger:** `hello {name}`
**Example message:** `hello Alice`
**Response:** `Hello Alice! You sent: hello Alice`

### weather.py (Python)
Weather lookup template (stub implementation).

**Trigger:** `weather {location}`
**Example message:** `weather 90210`
**Response:** `Weather for 90210: Sunny, 72°F`

### info.sh (Shell)
System information script showing uptime.

**Trigger:** `info`
**Example message:** `info`
**Response:** `System uptime: 3:45. From node: 123456789`

## Creating Custom Scripts

### Node.js Example
```javascript
#!/usr/bin/env node

const name = process.env.PARAM_name || 'stranger';
const response = {
  response: `Hello ${name}!`
};

console.log(JSON.stringify(response));
```

### Python Example
```python
#!/usr/bin/env python3
import os
import json

name = os.environ.get('PARAM_name', 'stranger')
response = {
    "response": f"Hello {name}!"
}

print(json.dumps(response))
```

### Shell Example
```bash
#!/bin/sh

NAME="${PARAM_name:-stranger}"

cat <<EOF
{
  "response": "Hello ${NAME}!"
}
EOF
```

## Security Notes

- Scripts are sandboxed to `/data/scripts/` directory only
- Path traversal attempts (`..`) are blocked
- Scripts have 10-second execution timeout
- Scripts run with container user permissions (not root)
- Output is limited to 1MB

## Debugging

View script execution logs:
```bash
docker logs -f meshmonitor
```

Scripts can write debug info to stderr (appears in logs):
```javascript
console.error('Debug:', someVariable);  // Node.js
```
```python
print('Debug:', some_variable, file=sys.stderr)  # Python
```
```bash
echo "Debug: $VARIABLE" >&2  # Shell
```

## Performance Tips

- Keep scripts fast (< 1 second preferred)
- Cache external API results if possible
- Use async I/O for network requests
- Test scripts locally before deployment
