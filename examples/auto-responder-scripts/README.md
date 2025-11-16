# Auto Responder Script Examples

This directory contains example scripts for use with MeshMonitor's Auto Responder feature.

## Using Scripts with Auto Responder

### Option 1: Using Volume Mounts (Recommended)

If your `docker-compose.yaml` includes a volume mount like `./scripts:/data/scripts`:

1. **Place scripts in your local `./scripts` directory:**
   ```bash
   cp examples/auto-responder-scripts/hello.js ./scripts/
   cp examples/auto-responder-scripts/weather.py ./scripts/
   cp examples/auto-responder-scripts/PirateWeather.py ./scripts/
   cp examples/auto-responder-scripts/info.sh ./scripts/
   ```

2. **Make scripts executable (if needed):**
   ```bash
   chmod +x ./scripts/*.js
   chmod +x ./scripts/*.py
   chmod +x ./scripts/*.sh
   ```

3. **Restart container** (if running) to pick up new scripts, or they'll be available immediately if container is already running.

### Option 2: Copying to Container (Without Volume Mounts)

If you're not using volume mounts, copy scripts directly to the container:

1. **Copy scripts to the container's /data/scripts directory:**
   ```bash
   docker cp hello.js meshmonitor:/data/scripts/
   docker cp weather.py meshmonitor:/data/scripts/
   docker cp PirateWeather.py meshmonitor:/data/scripts/
   docker cp info.sh meshmonitor:/data/scripts/
   ```

2. **Make scripts executable (if needed):**
   ```bash
   docker exec meshmonitor chmod +x /data/scripts/*.js
   docker exec meshmonitor chmod +x /data/scripts/*.py
   docker exec meshmonitor chmod +x /data/scripts/*.sh
   ```

### Configure Auto Responder in MeshMonitor UI:

1. Navigate to **Settings → Automation → Auto Responder**
2. Click **"Add Trigger"** button
3. Fill in the trigger configuration:
   - **Trigger Pattern**: Enter the pattern to match (e.g., `hello {name}` or `weather {location}`)
   - **Response Type**: Select **"Script"** from the dropdown
   - **Response**: Either:
     - Select your script from the dropdown (if available), or
     - Enter the full path manually (e.g., `/data/scripts/hello.js` or `/data/scripts/PirateWeather.py`)
4. Click **"Save Changes"** or **"Add Trigger"** to save

**Example for PirateWeather.py:**
- **Trigger Pattern**: `weather {location}`
- **Response Type**: `Script`
- **Response**: `/data/scripts/PirateWeather.py` (or select from dropdown if available)

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

Scripts can output single or multiple responses:

**Single Response:**
```json
{
  "response": "Your response text here (max 200 chars)"
}
```

**Multiple Responses:**
```json
{
  "responses": [
    "First message (max 200 chars)",
    "Second message (max 200 chars)",
    "Third message (max 200 chars)"
  ]
}
```

When using multiple responses, each message will be queued individually and sent with rate limiting (30 seconds between messages) and retry logic (up to 3 attempts).

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

### PirateWeather.py (Python)
Complete Pirate Weather API integration with Nominatim geocoding. Supports flexible location input (city, zip code, address, etc.) and provides detailed weather information including current conditions, daily highs/lows, humidity, and wind speed.

**Requirements:**
- `PIRATE_WEATHER_API_KEY` environment variable (get free key from https://pirateweather.net/)
- Python 3.6+

**Trigger:** `weather, weather {location}`
**Example messages:**
- `weather` (shows help)
- `weather 90210`
- `weather "New York, NY"`
- `weather Paris, France`

**Response:** 
- `weather` → Shows help text with usage examples
- `weather {location}` → Detailed weather information including current temperature, feels-like temperature, daily high/low, humidity, and wind speed

**Setup:**
1. Get API key from https://pirateweather.net/
2. Add `PIRATE_WEATHER_API_KEY=your_key` to docker-compose.yaml environment variables
3. Ensure volume mount `./scripts:/data/scripts` in docker-compose.yaml
4. Copy `PirateWeather.py` to your local `./scripts/` directory (automatically available in container via volume mount)
5. Make executable: `chmod +x ./scripts/PirateWeather.py`
6. Configure trigger in MeshMonitor UI:
   - Navigate to **Settings → Automation → Auto Responder**
   - Click **"Add Trigger"**
   - **Trigger Pattern**: `weather, weather {location}` (multi-pattern: matches both "weather" and "weather {location}")
   - **Response Type**: Select **"Script"** from dropdown
   - **Response**: `/data/scripts/PirateWeather.py` (or select from script dropdown if available)
   - Click **"Save Changes"**

### info.sh (Shell)
System information script showing uptime.

**Trigger:** `info`
**Example message:** `info`
**Response:** `System uptime: 3:45. From node: 123456789`

### lorem.js / lorem.py / lorem.sh
Multi-message example scripts that demonstrate returning multiple responses.

**Trigger:** `lorem`
**Example message:** `lorem`
**Responses:** Three sequential messages containing Lorem Ipsum text, sent 30 seconds apart with retry logic.

## Regex Pattern Examples

You can use custom regex patterns in trigger patterns for more precise matching:

**Numeric Patterns:**
- `w {zip:\d{5}}` - Matches only 5-digit zip codes
- `temp {value:\d+}` - Matches only numeric values
- `set {num:-?\d+}` - Matches positive or negative integers

**Multi-word Patterns:**
- `weather {location:[\w\s]+}` - Matches locations with spaces (e.g., "new york")
- `alert {message:.+}` - Matches everything including punctuation

**Common Patterns:**
- `\d+` - One or more digits
- `\d{5}` - Exactly 5 digits
- `[\w\s]+` - Word characters and spaces
- `.+` - Any character (including spaces and punctuation)

See the [developer documentation](../../docs/developers/auto-responder-scripting.md) for more regex examples.

## Multiple Patterns Per Trigger

You can specify multiple patterns for a single trigger by separating them with commas. This is useful when you want one trigger to handle different message formats:

**Example: Ask Command**
- **Trigger:** `ask, ask {message}`
- **Messages:**
  - `ask` → Matches first pattern (show help)
  - `ask how are you` → Matches second pattern (process message)

**Example Script for Multi-Pattern:**
```python
#!/usr/bin/env python3
import os
import json

message = os.environ.get('PARAM_message', '').strip()

if not message:
    # No message - show help
    response = {"response": "Ask me anything! Usage: ask {your question}"}
else:
    # Process the question
    response = {"response": f"You asked: {message}"}

print(json.dumps(response))
```

**Example: Help Command**
- **Trigger:** `help, help {command}`
- **Messages:**
  - `help` → Shows general help
  - `help weather` → Shows help for weather command

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
