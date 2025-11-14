# Auto Responder Scripting Guide

## Overview

MeshMonitor's Auto Responder feature supports executing custom scripts in response to mesh messages. This enables advanced automation, dynamic content generation, external API integration, and complex logic beyond simple text responses.

Scripts can be written in **Node.js**, **Python**, or **Shell** and are executed in the MeshMonitor container with full access to message context via environment variables.

## Supported Languages

| Language | Extensions | Interpreter | Version |
|----------|-----------|-------------|---------|
| **Node.js** | `.js`, `.mjs` | `/usr/local/bin/node` | v22.21.1 |
| **Python** | `.py` | `/usr/bin/python3` | 3.12.12 |
| **Shell** | `.sh` | `/bin/sh` | BusyBox ash (Alpine) |

## Quick Start

### 1. Create a Script

**Example: `hello.js`**
```javascript
#!/usr/bin/env node

const name = process.env.PARAM_name || 'stranger';
const response = {
  response: `Hello ${name}! You sent: ${process.env.MESSAGE}`
};

console.log(JSON.stringify(response));
```

### 2. Deploy to Container

```bash
# Copy script to container
docker cp hello.js meshmonitor:/data/scripts/

# Make executable
docker exec meshmonitor chmod +x /data/scripts/hello.js
```

### 3. Configure Auto Responder

1. Navigate to **Settings → Automation → Auto Responder**
2. Click **Add Trigger**
3. Configure:
   - **Trigger:** `hello {name}`
   - **Type:** `Script`
   - **Response:** `/data/scripts/hello.js` (select from dropdown)
4. Click **Save Changes**

### 4. Test

Send a direct message to your node:
```
hello Alice
```

Expected response:
```
Hello Alice! You sent: hello Alice
```

## Script Requirements

### Must Have

✅ **Location:** Scripts must be in `/data/scripts/` directory
✅ **Extension:** `.js`, `.mjs`, `.py`, or `.sh`
✅ **Output:** Valid JSON to stdout with `response` field
✅ **Timeout:** Complete within 10 seconds
✅ **Executable:** Have execute permissions (`chmod +x`)

### JSON Output Format

Scripts must print JSON to stdout:

```json
{
  "response": "Your response text (max 200 characters)"
}
```

**Optional fields** (reserved for future use):
```json
{
  "response": "Your response text",
  "actions": {
    "notify": false,
    "log": true
  }
}
```

## Environment Variables

All scripts receive these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `MESSAGE` | Full message text received | `"weather miami"` |
| `FROM_NODE` | Sender's node number | `"123456789"` |
| `PACKET_ID` | Message packet ID | `"987654321"` |
| `TRIGGER` | Trigger pattern that matched | `"weather {location}"` |
| `PARAM_*` | Extracted parameters | `PARAM_location="miami"` |

### Parameter Extraction

Parameters are extracted from trigger patterns using `{paramName}` syntax:

**Trigger:** `weather {location}`
**Message:** `weather miami`
**Environment:** `PARAM_location="miami"`

**Trigger:** `forecast {city},{state}`
**Message:** `forecast austin,tx`
**Environment:**
- `PARAM_city="austin"`
- `PARAM_state="tx"`

## Language-Specific Examples

### Node.js

**Basic Example:**
```javascript
#!/usr/bin/env node

const response = {
  response: `Hello from Node.js v${process.version}!`
};

console.log(JSON.stringify(response));
```

**With Environment Variables:**
```javascript
#!/usr/bin/env node

const location = process.env.PARAM_location || 'Unknown';
const message = process.env.MESSAGE;
const fromNode = process.env.FROM_NODE;

const response = {
  response: `Weather for ${location} requested by node ${fromNode}`
};

console.log(JSON.stringify(response));
```

**With External API (using fetch):**
```javascript
#!/usr/bin/env node

const location = process.env.PARAM_location || 'Unknown';

async function getWeather() {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=3`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const weather = await response.text();

    return {
      response: weather.trim()
    };
  } catch (error) {
    return {
      response: `Failed to get weather for ${location}`
    };
  }
}

getWeather().then(result => {
  console.log(JSON.stringify(result));
}).catch(error => {
  console.log(JSON.stringify({ response: 'Error: ' + error.message }));
});
```

**With Error Handling:**
```javascript
#!/usr/bin/env node

try {
  const name = process.env.PARAM_name;

  if (!name) {
    throw new Error('Name parameter required');
  }

  const response = {
    response: `Hello ${name}!`
  };

  console.log(JSON.stringify(response));
} catch (error) {
  console.error('Error:', error.message);  // Goes to container logs
  console.log(JSON.stringify({
    response: 'Error processing request'
  }));
}
```

### Python

**Basic Example:**
```python
#!/usr/bin/env python3
import os
import json

name = os.environ.get('PARAM_name', 'stranger')
response = {
    "response": f"Hello {name} from Python!"
}

print(json.dumps(response))
```

**With External API:**
```python
#!/usr/bin/env python3
import os
import json
import urllib.request
import sys

location = os.environ.get('PARAM_location', 'Unknown')

try:
    url = f"https://wttr.in/{location}?format=3"
    with urllib.request.urlopen(url, timeout=5) as response:
        weather = response.read().decode('utf-8').strip()

    output = {"response": weather}
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)  # Goes to container logs
    output = {"response": f"Weather unavailable for {location}"}

print(json.dumps(output))
```

**With Apprise Integration:**
```python
#!/usr/bin/env python3
import os
import json
import sys

# Access Apprise virtual environment
sys.path.insert(0, '/opt/apprise-venv/lib/python3.12/site-packages')

try:
    import apprise

    message = os.environ.get('MESSAGE', 'No message')
    from_node = os.environ.get('FROM_NODE', 'Unknown')

    # Send notification
    apobj = apprise.Apprise()
    apobj.add('mailto://user:pass@gmail.com')
    apobj.notify(
        body=f'Message from node {from_node}: {message}',
        title='Mesh Message'
    )

    output = {"response": "Notification sent!"}
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    output = {"response": "Notification failed"}

print(json.dumps(output))
```

### Shell

**Basic Example:**
```bash
#!/bin/sh

NAME="${PARAM_name:-stranger}"

cat <<EOF
{
  "response": "Hello ${NAME} from Shell!"
}
EOF
```

**With System Commands:**
```bash
#!/bin/sh

# Get system uptime
UPTIME=$(uptime | awk '{print $3}')

# Get load average
LOAD=$(uptime | awk -F'load average:' '{print $2}' | xargs)

cat <<EOF
{
  "response": "Uptime: ${UPTIME}, Load: ${LOAD}"
}
EOF
```

**With Environment Variables:**
```bash
#!/bin/sh

MESSAGE="${MESSAGE}"
FROM_NODE="${FROM_NODE}"
LOCATION="${PARAM_location:-Unknown}"

cat <<EOF
{
  "response": "Location: ${LOCATION}, From: ${FROM_NODE}"
}
EOF
```

## Advanced Patterns

### Database Queries

**Python with SQLite:**
```python
#!/usr/bin/env python3
import os
import json
import sqlite3

node_id = os.environ.get('PARAM_nodeid', 'Unknown')

try:
    conn = sqlite3.connect('/data/meshmonitor.db')
    cursor = conn.cursor()

    cursor.execute(
        "SELECT longName, lastSeen FROM nodes WHERE nodeId = ?",
        (node_id,)
    )

    result = cursor.fetchone()
    conn.close()

    if result:
        output = {
            "response": f"{result[0]} last seen {result[1]}"
        }
    else:
        output = {"response": f"Node {node_id} not found"}

except Exception as e:
    output = {"response": "Database error"}

print(json.dumps(output))
```

### Multi-Step Logic

**Node.js with Conditional Responses:**
```javascript
#!/usr/bin/env node

const command = process.env.PARAM_command;
const arg = process.env.PARAM_arg;

let response;

switch (command) {
  case 'status':
    response = `System status: OK`;
    break;
  case 'info':
    response = `Node info: ${process.env.FROM_NODE}`;
    break;
  case 'weather':
    response = `Weather for ${arg}: Checking...`;
    break;
  default:
    response = `Unknown command: ${command}`;
}

console.log(JSON.stringify({ response }));
```

### Caching Results

**Python with File Cache:**
```python
#!/usr/bin/env python3
import os
import json
import time

CACHE_FILE = '/data/scripts/.cache/weather.json'
CACHE_TTL = 300  # 5 minutes

location = os.environ.get('PARAM_location', 'Unknown')

# Check cache
try:
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_TTL:
            with open(CACHE_FILE, 'r') as f:
                cached = json.load(f)
                if cached.get('location') == location:
                    print(json.dumps({"response": cached['data']}))
                    exit(0)
except Exception:
    pass

# Fetch fresh data (implement API call here)
weather_data = f"Weather for {location}: Sunny, 72°F"

# Save to cache
try:
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, 'w') as f:
        json.dump({'location': location, 'data': weather_data}, f)
except Exception:
    pass

print(json.dumps({"response": weather_data}))
```

## Debugging

### View Execution Logs

```bash
# Tail container logs in real-time
docker logs -f meshmonitor

# Search for script errors
docker logs meshmonitor 2>&1 | grep -i "script"

# View last 100 lines
docker logs meshmonitor --tail 100
```

### Script Debug Output

**Node.js:**
```javascript
console.error('Debug:', someVariable);  // Appears in container logs
console.log(JSON.stringify({response: 'OK'}));  // Sent to mesh
```

**Python:**
```python
print(f'Debug: {some_variable}', file=sys.stderr)  # Logs
print(json.dumps({"response": "OK"}))  # Response
```

**Shell:**
```bash
echo "Debug: $VARIABLE" >&2  # Logs
cat <<EOF  # Response
{"response": "OK"}
EOF
```

### Test Scripts Locally

```bash
# Test Node.js script
docker exec meshmonitor sh -c 'export MESSAGE="test" PARAM_name="Alice" && /usr/local/bin/node /data/scripts/hello.js'

# Test Python script
docker exec meshmonitor sh -c 'export MESSAGE="weather miami" PARAM_location="miami" && /usr/bin/python3 /data/scripts/weather.py'

# Test Shell script
docker exec meshmonitor sh -c 'export MESSAGE="info" FROM_NODE="123" && /bin/sh /data/scripts/info.sh'
```

## Security Considerations

### Sandboxing

✅ Scripts run as `node` user (not root)
✅ Limited to `/data/scripts/` directory
✅ Path traversal attempts (`..`) are blocked
✅ 10-second execution timeout
✅ Output limited to 1MB

### Best Practices

**DO:**
- ✅ Validate all parameters before use
- ✅ Handle errors gracefully
- ✅ Use timeout for external API calls
- ✅ Sanitize user input
- ✅ Log errors to stderr for debugging

**DON'T:**
- ❌ Trust user input without validation
- ❌ Execute arbitrary commands from parameters
- ❌ Store secrets in script files
- ❌ Make unbounded API calls
- ❌ Ignore error handling

### Example: Input Validation

```javascript
#!/usr/bin/env node

const location = process.env.PARAM_location || '';

// Validate input
if (!/^[a-zA-Z0-9\s,-]{1,50}$/.test(location)) {
  console.log(JSON.stringify({
    response: 'Invalid location format'
  }));
  process.exit(0);
}

// Safe to use location
const response = {
  response: `Weather for ${location}: ...`
};

console.log(JSON.stringify(response));
```

## Performance Tips

### Optimize Script Execution

1. **Keep scripts fast (< 1 second preferred)**
   - Cache external API results
   - Use efficient algorithms
   - Minimize disk I/O

2. **Use async I/O for network requests**
   - Node.js: Use `fetch` with timeout
   - Python: Use `urllib` with timeout
   - Shell: Use `curl` with `--max-time`

3. **Implement caching when appropriate**
   - File-based cache for API responses
   - Memory cache for frequently accessed data
   - Respect cache TTL

4. **Test scripts locally before deployment**
   - Verify JSON output format
   - Test error handling
   - Measure execution time

### Example: Efficient API Call

```javascript
#!/usr/bin/env node

const location = process.env.PARAM_location;

async function getWeather() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(
      `https://api.example.com/weather/${location}`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'MeshMonitor' }
      }
    );

    if (!response.ok) throw new Error('API error');

    const data = await response.json();
    return { response: data.summary };
  } catch (error) {
    return { response: 'Weather unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

getWeather().then(result => console.log(JSON.stringify(result)));
```

## Troubleshooting

### Common Issues

**Script doesn't appear in dropdown:**
- Verify file is in `/data/scripts/`
- Check file extension (`.js`, `.mjs`, `.py`, `.sh`)
- Refresh the Auto Responder page

**Script executes but no response:**
- Check JSON output format (must have `response` field)
- Verify stdout (not stderr) is used
- Check for script errors in logs: `docker logs meshmonitor`

**Timeout errors:**
- Reduce external API timeout
- Optimize slow operations
- Check for infinite loops

**Permission denied:**
- Make script executable: `chmod +x /data/scripts/script.py`
- Verify file ownership is correct

**Parameters not extracted:**
- Verify trigger pattern uses `{paramName}` syntax
- Check environment variable names match (case-sensitive)
- Parameters can't contain spaces

## Example Scripts Repository

Complete example scripts are available in the MeshMonitor repository:

**GitHub:** [examples/auto-responder-scripts/](https://github.com/MeshAddicts/meshmonitor/tree/main/examples/auto-responder-scripts)

- `hello.js` - Simple Node.js greeting script
- `weather.py` - Python weather lookup template
- `info.sh` - Shell system information script
- `README.md` - Detailed examples and usage

## API Reference

### /api/scripts Endpoint

**Method:** GET
**Authentication:** None (public endpoint)
**Response:**
```json
{
  "scripts": [
    "/data/scripts/hello.js",
    "/data/scripts/info.sh",
    "/data/scripts/weather.py"
  ]
}
```

This endpoint is called automatically by the Auto Responder UI to populate the script dropdown.

## Version Compatibility

| MeshMonitor Version | Feature |
|-------------------|---------|
| v2.18.0+ | Script execution support |
| v2.17.8 | Text and HTTP responses only |

## Support

For issues, questions, or feature requests:
- **GitHub Issues:** https://github.com/MeshAddicts/meshmonitor/issues
- **Documentation:** https://meshmonitor.org/features/automation#auto-responder
- **Examples:** https://github.com/MeshAddicts/meshmonitor/tree/main/examples/auto-responder-scripts

## License

MeshMonitor is licensed under the MIT License. See [LICENSE](https://github.com/MeshAddicts/meshmonitor/blob/main/LICENSE) for details.
