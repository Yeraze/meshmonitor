# Writing Automation Scripts

## Overview

MeshMonitor can run your own scripts when an automation fires. Use them to call web APIs, build replies on the fly, or run logic a plain text reply can't.

Four features run scripts. They share one script folder (`/data/scripts/`), the same languages, and the same runner:

| Caller | Gets context from | Sends the output |
|---|---|---|
| [Auto Responder](/features/automation-messages#auto-responder) | Message [environment variables](#environment-variables) and [arguments](#script-arguments) | Yes, as the reply |
| [Timer Triggers](/features/automation-triggers#timer-triggers) | [Timer variables and tokens](#timer-trigger-scripts) | Yes, to the chosen channel |
| [Geofence Triggers](/features/automation-triggers#geofence-triggers) | [Geofence variables and tokens](#geofence-trigger-scripts) | Yes, to the chosen channel or DM |
| [Automation Engine](/features/automation-engine) **Run a script** action | [`MM_*` variables](#automation-engine-scripts) | No. Store the output and send it with a later action |

Most of this guide uses the Auto Responder as the example. The [last sections](#timer-trigger-scripts) list what the other callers pass.

Write scripts in **Node.js**, **Python**, or **Shell**. They run inside the MeshMonitor container.

## Supported Languages

| Language | Extensions | Interpreter | Version |
|----------|-----------|-------------|---------|
| **Node.js** | `.js`, `.mjs` | `/usr/local/bin/node` | 24 (from the Docker image) |
| **Python** | `.py` | `/usr/bin/python3` | 3.14 (Alpine package) |
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

**Option A: Using the UI (Recommended)**

1. Open the source's **Automation** view and go to **Auto Responder**
2. Scroll down to **Script Management** section
3. Click **Import Script**
4. Select your script file (`.js`, `.mjs`, `.py`, or `.sh`)
5. The script will be automatically uploaded and made executable

**Option B: Manual Deployment**

```bash
# Copy script to container
docker cp hello.js meshmonitor:/data/scripts/

# Make executable
docker exec meshmonitor chmod +x /data/scripts/hello.js
```

**Option C: Docker Compose (mount the scripts folder)**

::: tip Use the Configurator
The easiest way to set up scripts volume mounting is using the **[Docker Compose Configurator](/configurator)** - just check "Mount Auto Responder Scripts Directory" under Additional Settings!
:::

To edit scripts on the host instead of copying them into the container:

```yaml
services:
  meshmonitor:
    image: yeraze/meshmonitor:latest
    container_name: meshmonitor
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      # Mount scripts directory for easy script management
      - ./scripts:/data/scripts
      # Mount data directory for persistence
      - ./data:/data
    environment:
      # Timezone configuration (for timezone-aware scripts)
      - TZ=America/New_York
      # Needed to store Script Secrets (API keys); see below.
      # Put SESSION_SECRET=<output of: openssl rand -hex 32> in a .env file.
      - SESSION_SECRET=${SESSION_SECRET}
```

**Benefits:**
- **Volume Mapping:** `./scripts:/data/scripts` allows editing scripts locally without copying into container
- **Timezone:** Set `TZ` for timezone-aware scripts (see [Timezone Support](#timezone-support))

::: warning API keys don't go in the compose file
Scripts do **not** see every container variable. MeshMonitor strips any variable whose name looks like a secret (`*API_KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `DATABASE_*` and so on), so an uploaded script can't read the server's own keys. A `PIRATE_WEATHER_API_KEY` set in `environment:` never reaches the script. Store it as a [Script Secret](#script-secrets) instead.
:::

### 3. Configure Auto Responder

1. Open the source's **Automation** view and go to **Auto Responder**
2. Click **Add Trigger** to open a new trigger card
3. Configure:
   - **Trigger:** `hello {name}`
   - **Type:** `Script`
   - **Response:** `/data/scripts/hello.js` (select from dropdown)
4. Click **Done**, then **Save**

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
✅ **Timeout:** Complete within 30 seconds
✅ **Executable:** Have execute permissions (`chmod +x`)

### Script Metadata (mm_meta)

Scripts can include optional metadata that enhances their display in the MeshMonitor UI. When present, scripts show their name and emoji in dropdowns instead of just the file path, and Timer triggers can auto-fill their name from the script metadata.

**Format:**

Add a `mm_meta:` block near the top of your script as comments:

**Python/Shell:**
```python
#!/usr/bin/env python3
# mm_meta:
#   name: Weather Lookup
#   emoji: 🌤️
#   language: Python
```

**JavaScript/Node.js:**
```javascript
#!/usr/bin/env node
// mm_meta:
//   name: Hello World
//   emoji: 👋
//   language: JavaScript
```

**Available Fields:**

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Human-readable script name | `Weather Lookup` |
| `emoji` | Icon/emoji for visual identification | `🌤️`, `📏`, `🔋` |
| `language` | Programming language | `Python`, `JavaScript`, `Shell` |
| `version` | Optional release version, shown in **Settings → Scripts** and the [User Scripts Gallery](/user-scripts) | `1.2.0` |
| `author` | Optional author name, shown in **Settings → Scripts** | `KD2ABC` |
| `source` | Optional GitHub path to the published file, so MeshMonitor can check for newer versions (#5255). `repository:` works too. | `KD2ABC/mesh-scripts/weather.py` |

**Update checks:** with both `version` and `source` set, **Settings → Scripts** can ask GitHub which version your repository publishes and offer the operator a one-click update. MeshMonitor never updates a script on its own: an admin presses **Check for updates**, reads what changed, and presses **Update**. The replaced file is kept so the update can be rolled back. Scripts listed in the gallery are matched by filename, so they need no `source` of their own; for anything else an admin can type the GitHub path in **Settings → Scripts**.

**Versioning:** bump `version` in your script's `mm_meta` each time you publish a change. The gallery reads it straight from your repository, so a new release shows up there without a gallery pull request. Use a plain token such as `1.2.0` or `2.0.0-beta.1` (letters, digits, `.`, `+`, `-`, up to 20 characters; a leading `v` is dropped).

**Benefits:**

1. **Enhanced UI Display**: Scripts appear as "🌤️ Weather Lookup" instead of "/data/scripts/weather.py"
2. **Timer Name Autofill**: When selecting a script with metadata for a Timer trigger, the Timer Name field automatically fills with the script's name
3. **Better Organization**: Easily identify scripts at a glance in dropdowns and management lists

**Example Scripts with Metadata:**

```python
#!/usr/bin/env python3
# mm_meta:
#   name: Distance Calculator
#   emoji: 📏
#   language: Python
"""
Calculates distance between sender and MeshMonitor node.
"""
import os
import json
# ... rest of script
```

```bash
#!/bin/sh
# mm_meta:
#   name: System Info
#   emoji: ℹ️
#   language: Shell
# Returns system uptime information
```

**Note:** The `mm_meta:` block must appear within the first 1KB of the script file. Language is auto-detected from file extension if not specified.

### JSON Output Format

Scripts must print JSON to stdout:

```json
{
  "response": "Your response text (max 200 characters)"
}
```

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `responses` | `string[]` | Multiple response messages. If present, `response` is ignored. Each item is sent as its own mesh packet. |
| `private` | `boolean` | Overrides the reply target. `true` forces a DM to the sender; `false` forces a reply on the channel where the trigger fired (even if the trigger was a DM). When omitted, the reply follows the original message (DM → DM, channel → channel). |

**Example: force a DM reply**

```python
print(json.dumps({
    "response": "Here is your private link",
    "private": True,
}))
```

**Reserved for future use:**
```json
{
  "response": "Your response text",
  "actions": {
    "notify": false,
    "log": true
  }
}
```

## Script Arguments

Scripts can receive command-line arguments via the **Arguments** field in the MeshMonitor UI. Arguments support token expansion, allowing dynamic values to be passed to scripts at runtime.

### How It Works

When you configure a script trigger with arguments:
1. MeshMonitor expands any tokens (e.g., `{NODE_ID}`) with their runtime values
2. Arguments are parsed using shell-style quoting (supports single and double quotes)
3. Arguments are passed to the script as command-line arguments (`sys.argv` in Python, `process.argv` in Node.js, `$@` in Shell)

### Example Configuration

```
Trigger: admin {command}
Response Type: Script
Response: /data/scripts/remote-admin.py
Arguments: --dest {NODE_ID} --{command}
```

When someone sends "admin reboot", the script is called as:
```bash
/data/scripts/remote-admin.py --dest !abc12345 --reboot
```

### Available Tokens (Auto Responder)

| Token | Description | Example |
|-------|-------------|---------|
| `{NODE_ID}` | Sender's node ID | `!a1b2c3d4` |
| `{LONG_NAME}` | Sender's long name | `Alice's Node` |
| `{SHORT_NAME}` | Sender's short name | `ALI` |
| `{IP}` | Meshtastic node IP | `192.168.1.100` |
| `{PORT}` | Meshtastic TCP port | `4403` |
| `{VERSION}` | MeshMonitor version | `v3.4.0` |
| `{NODECOUNT}` | Active node count | `42` |
| `{DIRECTCOUNT}` | Direct node count | `15` |
| `{HOPS}` | Message hop count | `2` |
| `{SNR}` | Signal-to-noise ratio | `7.5` |
| `{RSSI}` | Signal strength | `-95` |
| `{CHANNEL}` | Channel name | `LongFast` |
| `{DATE}` | Current date | `1/15/2025` |
| `{TIME}` | Current time | `2:30:00 PM` |
| `{LAST_HOP}` | Last relay node (short name → hex byte → `unknown`) | `RLY1` |

> **Note:** These tokens are also supported in HTTP response URLs. When used in URLs, token values are automatically URI-encoded for safety (e.g., spaces become `%20`, slashes become `%2F`). Extracted parameters from regex capture groups take precedence over built-in tokens of the same name.

### Accessing Arguments in Scripts

**Python:**
```python
#!/usr/bin/env python3
import sys
import json

# Arguments are in sys.argv[1:]
args = sys.argv[1:]
print(f"Received args: {args}", file=sys.stderr)

# Example: Parse with argparse
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--dest', help='Destination node')
parser.add_argument('--reboot', action='store_true')
parsed, unknown = parser.parse_known_args()

if parsed.reboot:
    response = {"response": f"Rebooting {parsed.dest}..."}
else:
    response = {"response": "No action specified"}

print(json.dumps(response))
```

**Node.js:**
```javascript
#!/usr/bin/env node

// Arguments are in process.argv.slice(2)
const args = process.argv.slice(2);
console.error('Received args:', args);

// Simple flag parsing
const hasReboot = args.includes('--reboot');
const destIndex = args.indexOf('--dest');
const dest = destIndex !== -1 ? args[destIndex + 1] : null;

const response = hasReboot
  ? { response: `Rebooting ${dest}...` }
  : { response: 'No action specified' };

console.log(JSON.stringify(response));
```

**Shell:**
```bash
#!/bin/sh

# Arguments are in $@ or $1, $2, etc.
echo "Received args: $@" >&2

# Parse arguments
DEST=""
REBOOT=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dest) DEST="$2"; shift 2;;
        --reboot) REBOOT=true; shift;;
        *) shift;;
    esac
done

if [ "$REBOOT" = true ]; then
    cat <<EOF
{"response": "Rebooting ${DEST}..."}
EOF
else
    cat <<EOF
{"response": "No action specified"}
EOF
fi
```

### Quoting in Arguments

Arguments support shell-style quoting for values with spaces:

| Arguments | Parsed Result |
|-----------|---------------|
| `--flag --value test` | `["--flag", "--value", "test"]` |
| `--set 'lora.region US'` | `["--set", "lora.region US"]` |
| `--msg "Hello World"` | `["--msg", "Hello World"]` |
| `--dest '!abc123' --reboot` | `["--dest", "!abc123", "--reboot"]` |

### Use Cases

**Remote Administration:**
```
Arguments: --reboot
Arguments: --set lora.region US
Arguments: --setlat 40.7128 --setlon -74.0060
```

**Custom Scripts:**
```
Arguments: --format json --verbose
Arguments: --ip {IP} --count {NODECOUNT}
Arguments: --dest {NODE_ID} --action '{command}'
```

## Environment Variables

All scripts receive these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `MESSAGE` | Full message text received | `"weather miami"` |
| `FROM_NODE` | Sender's node number | `"123456789"` |
| `NODE_ID` | Sender's node ID (hex format) | `"!a2e4ff4c"` |
| `SHORT_NAME` | Sender's short name (if known) | `"JOHN"` |
| `LONG_NAME` | Sender's long name (if known) | `"John Doe"` |
| `FROM_SHORT_NAME` | Sender's short name (alias for `SHORT_NAME`) | `"JOHN"` |
| `FROM_LONG_NAME` | Sender's long name (alias for `LONG_NAME`) | `"John Doe"` |
| `FROM_LAT` | Sender's latitude (if known) | `"25.7617"` |
| `FROM_LON` | Sender's longitude (if known) | `"-80.1918"` |
| `MM_LAT` | MeshMonitor node's latitude (if known) | `"25.7617"` |
| `MM_LON` | MeshMonitor node's longitude (if known) | `"-80.1918"` |
| `HOPS` | Number of hops the message traveled | `"2"` |
| `SNR` | Signal-to-noise ratio of received packet | `"6.25"` |
| `RSSI` | Received signal strength indicator | `"-98"` |
| `CHANNEL` | Channel number the message was received on | `"0"` |
| `VERSION` | Sender's firmware version (if known) | `"2.5.6.a1b2c3d"` |
| `NODECOUNT` | Number of active nodes on the mesh | `"42"` |
| `VIA_MQTT` | Whether message arrived via MQTT bridge | `"true"` |
| `IS_DIRECT` | Whether the message is a direct message | `"true"` |
| `PACKET_ID` | Message packet ID | `"987654321"` |
| `MESHTASTIC_IP` | IP address of the connected Meshtastic node | `"192.168.1.100"` |
| `MESHTASTIC_PORT` | TCP port of the connected Meshtastic node | `"4403"` |
| `TRIGGER` | Trigger pattern that matched | `"weather {location}"` |
| `MATCHED_PATTERN` | The specific pattern that matched | `"weather {location}"` |
| `PARAM_*` | Extracted parameters | `PARAM_location="miami"` |
| `MSG_*` | All message fields as individual variables | `MSG_text="weather miami"` |
| `TZ` | Server timezone (IANA timezone name) | `"America/New_York"` |
| *your secrets* | Every [Script Secret](#script-secrets), under its own name | `OPENAI_API_KEY="sk-…"` |

### Script Secrets

Store API keys and other values your scripts need in **Settings › Scripts › Script Secrets** (admins only). Each secret reaches every script as an environment variable of the same name:

```python
import os
api_key = os.environ.get("PIRATE_WEATHER_API_KEY")
```

```javascript
const apiKey = process.env.PIRATE_WEATHER_API_KEY;
```

How it works:

- **Every script receives every secret.** There is no per-script or per-source scope. Any script uploaded to MeshMonitor can read every stored value, print it, send it over the mesh, or send it to any web server. Only upload scripts you trust.
- **Users who can edit automations** can point a trigger at an existing script, and so make that script use the secrets, even though they cannot see or change the secrets themselves.
- **Write only.** After you save a value, no page or API returns it. You can replace or delete it.
- **Encrypted at rest** with AES-256-GCM, using a key derived from `SESSION_SECRET`. Storing secrets needs `SESSION_SECRET` set in your environment; without it the panel is disabled, since an auto-generated key would change on every restart. If `SESSION_SECRET` changes, each secret shows as **Unreadable**, scripts stop receiving it, and you must enter it again.
- **Names** are upper-case letters, digits and underscores, up to 64 characters. Names scripts already receive or that control the shell, interpreter or loader are reserved (in any letter case): for example `PATH`, `HOME`, `SHELLOPTS`, `PS4`, `GCONV_PATH`, `OPENSSL_CONF`, `MESSAGE`, `CHANNEL`, `SESSION_SECRET`, and the `MM_` names MeshMonitor sets (`MM_LAT`, `MM_SOURCE_ID`, …), and names starting with `PARAM_`, `MSG_`, `FROM_`, `NODE_`, `MESHCORE_`, `MESHTASTIC_`, `GEOFENCE_`, `TIMER_`, `PYTHON`, `LD_`, `DATABASE_`.
- A secret never replaces a variable the script would see anyway. At most 50 secrets, each up to 4096 characters.
- **Logs:** MeshMonitor replaces stored values of 8 or more characters with `***` when it writes script output to its own log, and in the output shown when an admin tests a script. This is **best effort**: it misses a value the script encodes (base64, URL-encoding), splits or changes, and shorter values are not masked. It does not change what a script sends over the mesh.
- **Backups** include the secrets, still encrypted. A backup restored under a different `SESSION_SECRET` keeps them, but they show as Unreadable until you enter them again. See [System Backup](/features/system-backup#a-backup-is-a-secret).

### Location Environment Variables

Scripts can access location data for both the sender node and the MeshMonitor node:

- **`FROM_LAT`/`FROM_LON`**: The latitude/longitude of the node that sent the message. Only set if the sender's position is known in the database.
- **`MM_LAT`/`MM_LON`**: The latitude/longitude of the MeshMonitor's connected node. Only set if the node's position is known.

**Note:** These variables are only set when location data is available. Always check if they exist before using them.

**Example: Python distance calculation**
```python
#!/usr/bin/env python3
import os
import json
import math

def haversine(lat1, lon1, lat2, lon2):
    """Calculate distance in km between two points"""
    R = 6371  # Earth's radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * \
        math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))

# Get locations
from_lat = os.environ.get('FROM_LAT')
from_lon = os.environ.get('FROM_LON')
mm_lat = os.environ.get('MM_LAT')
mm_lon = os.environ.get('MM_LON')

if all([from_lat, from_lon, mm_lat, mm_lon]):
    dist = haversine(
        float(from_lat), float(from_lon),
        float(mm_lat), float(mm_lon)
    )
    response = f"You are {dist:.1f} km away from me"
else:
    response = "Location data not available"

print(json.dumps({"response": response}))
```

**Example: JavaScript distance calculation**
```javascript
#!/usr/bin/env node

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

const fromLat = process.env.FROM_LAT;
const fromLon = process.env.FROM_LON;
const mmLat = process.env.MM_LAT;
const mmLon = process.env.MM_LON;

let response;
if (fromLat && fromLon && mmLat && mmLon) {
  const dist = haversine(
    parseFloat(fromLat), parseFloat(fromLon),
    parseFloat(mmLat), parseFloat(mmLon)
  );
  response = `You are ${dist.toFixed(1)} km away from me`;
} else {
  response = "Location data not available";
}

console.log(JSON.stringify({ response }));
```

### Timezone Support

Scripts receive the `TZ` environment variable containing the server's configured timezone (IANA timezone name). This allows scripts to perform timezone-aware time operations.

**Configuration:**

The timezone is configured via the `TZ` environment variable in your `docker-compose.yaml`:

```yaml
environment:
  - TZ=America/New_York
```

**Example: Python Script**

```python
#!/usr/bin/env python3
import os
import json
from datetime import datetime

tz = os.environ.get('TZ', 'UTC')
now = datetime.now()
print(json.dumps({
    "response": f"Current time in {tz}: {now.strftime('%Y-%m-%d %H:%M:%S %Z')}"
}))
```

**Example: JavaScript Script**

```javascript
#!/usr/bin/env node
const tz = process.env.TZ || 'UTC';
const now = new Date();
console.log(JSON.stringify({
    response: `Current time in ${tz}: ${now.toLocaleString('en-US', { timeZone: tz })}`
}));
```

**Example: Shell Script**

```bash
#!/bin/sh
TZ="${TZ:-UTC}"
NOW=$(TZ="$TZ" date '+%Y-%m-%d %H:%M:%S %Z')
echo "{\"response\": \"Current time in $TZ: $NOW\"}"
```

**Common IANA Timezone Names:**

- `America/New_York` - Eastern Time
- `America/Chicago` - Central Time
- `America/Denver` - Mountain Time
- `America/Los_Angeles` - Pacific Time
- `Europe/London` - UK Time
- `UTC` - Coordinated Universal Time

For a complete list, see [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

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

### Custom Regex Patterns (Advanced)

You can specify custom regex patterns for parameters using `{paramName:regex}` syntax. This allows for more precise matching and validation:

**Basic Regex Examples:**

**Trigger:** `w {zip:\d{5}}`
**Message:** `w 33076`
**Environment:** `PARAM_zip="33076"`
**Note:** Only matches 5-digit zip codes

**Trigger:** `temp {value:\d+}`
**Message:** `temp 72`
**Environment:** `PARAM_value="72"`
**Note:** Only matches numeric values

**Trigger:** `coords {lat:-?\d+\.?\d*},{lon:-?\d+\.?\d*}`
**Message:** `coords 40.7128,-74.0060`
**Environment:**
- `PARAM_lat="40.7128"`
- `PARAM_lon="-74.0060"`
**Note:** Matches decimal coordinates (positive or negative)

**More Regex Examples:**

**Multi-word Parameters:**
**Trigger:** `weather {location:[\w\s]+}`
**Message:** `weather new york`
**Environment:** `PARAM_location="new york"`
**Note:** Matches locations with spaces using `[\w\s]+` pattern

**Everything Pattern:**
**Trigger:** `alert {message:.+}`
**Message:** `alert Hello, world!`
**Environment:** `PARAM_message="Hello, world!"`
**Note:** Matches everything including punctuation using `.+` pattern

**Common Regex Patterns:**
- `\d+` - One or more digits (e.g., `{value:\d+}`)
- `\d{5}` - Exactly 5 digits (e.g., `{zip:\d{5}}`)
- `[\w\s]+` - Word characters and spaces (e.g., `{location:[\w\s]+}`)
- `.+` - Any character including spaces and punctuation (e.g., `{message:.+}`)
- `-?\d+\.?\d*` - Optional negative, digits, optional decimal (e.g., `{temp:-?\d+\.?\d*}`)

**Default Behavior:** If no regex pattern is specified, parameters default to matching non-whitespace characters (`[^\s]+`)

**Escaping Special Characters:** Remember to escape special regex characters if they appear in your pattern: `\ . + * ? ^ $ { } [ ] ( ) |`

### Multiple Patterns Per Trigger

You can specify multiple patterns for a single trigger by separating them with commas. This is useful when you want one trigger to handle different message formats (e.g., a command with or without parameters):

**Example: Ask Command with Optional Message**

**Trigger:** `ask, ask {message}`
**Messages:**
- `ask` → Matches first pattern, no parameters extracted
- `ask how are you` → Matches second pattern, `PARAM_message="how are you"`

**Script Example:**
```python
#!/usr/bin/env python3
import os
import json

message = os.environ.get('PARAM_message', '').strip()

if not message:
    # No message provided - show help
    response = {
        "response": "Ask me anything! Usage: ask {your question}"
    }
else:
    # Process the question
    response = {
        "response": f"You asked: {message}. Processing..."
    }

print(json.dumps(response))
```

**Example: Help Command with Optional Command Name**

**Trigger:** `help, help {command}`
**Messages:**
- `help` → Shows general help
- `help weather` → Shows help for weather command

**Example: Temperature with Optional Value**

**Trigger:** `temp, temp {value:\d+}`
**Messages:**
- `temp` → Shows current temperature
- `temp 72` → Sets temperature to 72 (only numeric values accepted due to `\d+` pattern)

**Example: Weather Bot with Help**

**Trigger:** `weather, weather {location}`
**Messages:**
- `weather` → Shows help text with usage examples
- `weather 90210` → Gets weather for zip code 90210
- `weather "New York, NY"` → Gets weather for New York

**Script Example (PirateWeather.py):**
```python
#!/usr/bin/env python3
import os
import json

location = os.environ.get('PARAM_location', '').strip()

if not location:
    # No location - show help (triggered by "weather" pattern)
    response = {
        "response": "Weather Bot:\n• weather {location} - Get weather\nExamples:\n• weather 90210\n• weather \"New York, NY\""
    }
else:
    # Get weather for location (API call logic here)
    response = {
        "response": f"Weather for {location}: ..."
    }

print(json.dumps(response))
```

**Usage:** Enter patterns separated by commas in the trigger field. The first matching pattern will be used, and parameters will be extracted from that pattern.

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
sys.path.insert(0, '/opt/apprise-venv/lib/python3.14/site-packages')

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
from datetime import datetime, timezone

node_id = os.environ.get('PARAM_nodeid', 'Unknown')

try:
    conn = sqlite3.connect('/data/meshmonitor.db')
    cursor = conn.cursor()

    cursor.execute(
        "SELECT longName, lastHeard FROM nodes WHERE nodeId = ?",
        (node_id,)
    )

    result = cursor.fetchone()
    conn.close()

    if result:
        output = {
            "response": f"{result[0]} last heard {datetime.fromtimestamp(result[1], timezone.utc):%Y-%m-%d %H:%M} UTC" if result[1] else f"{result[0]} not heard yet"
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
✅ 30-second execution timeout
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
- Verify trigger pattern uses `{paramName}` syntax (or `{paramName:regex}` for custom patterns)
- Check environment variable names match (case-sensitive)
- Ensure custom regex patterns are valid and match the expected input
- Test trigger patterns using the "Test Trigger Matching" feature in the UI
- Remember: default pattern matches non-whitespace `[^\s]+`, custom patterns override this

## Example Scripts Repository

Complete example scripts are available in the MeshMonitor repository:

**GitHub:** [examples/auto-responder-scripts/](https://github.com/Yeraze/meshmonitor/tree/main/examples/auto-responder-scripts)

- `hello.js` - Simple Node.js greeting script
- `weather.py` - Python weather lookup template
- `PirateWeather.py` - Complete Pirate Weather API integration with Nominatim geocoding
- `info.sh` - Shell system information script
- `lorem.js`, `lorem.py`, `lorem.sh` - Return three messages at once, to show the `responses` array
- `README.md` - Detailed examples and usage

## Timer Trigger Scripts {#timer-trigger-scripts}

A [Timer Trigger](/features/automation-triggers#timer-triggers) runs its script on a cron schedule, with no incoming message. Its output goes to the channel the timer names.

**Environment variables:** `TIMER_NAME`, `TIMER_ID`, `TIMER_SCRIPT`, `MESHTASTIC_IP`, `MESHTASTIC_PORT`, and `MM_LAT` / `MM_LON` when the local node's position is known. The message variables (`MESSAGE`, `FROM_NODE`, `PARAM_*` …) are not set.

Timer triggers support passing command-line arguments to scripts via the **Arguments** field. Arguments support token expansion for dynamic values.

**Example Arguments:**
- `--ip {IP}` - Pass the node IP address
- `--count {NODECOUNT}` - Pass the active node count
- `--verbose --format json` - Pass multiple flags

**Available Tokens:**

| Token | Description | Example |
|-------|-------------|---------|
| `{IP}` | Meshtastic node IP | `192.168.1.100` |
| `{PORT}` | Meshtastic TCP port | `4403` |
| `{VERSION}` | MeshMonitor version | `v3.4.0` |
| `{NODECOUNT}` | Active node count | `42` |
| `{DIRECTCOUNT}` | Direct node count | `15` |
| `{DURATION}` | Server uptime | `2 days, 5 hours` |
| `{FEATURES}` | Enabled features | `🗺️ 🤖` |

**Example Configuration:**
```
Name: Scheduled Remote Admin
Schedule: 0 3 * * *
Script: remote-admin.py
Arguments: --ip {IP} --dest !abc12345 --reboot
Channel: 0 (Primary)
```

This runs a remote admin command every day at 3 AM.

**JSON Output Format** (same as the Auto Responder):

**Single Response:**
```json
{
  "response": "Your message text (max 200 chars)"
}
```

**Multiple Responses:**
```json
{
  "responses": [
    "First message",
    "Second message",
    "Third message"
  ]
}
```

**Example scripts:**

**Simple Status Script (status.js)**:
```javascript
#!/usr/bin/env node

const now = new Date();
const response = {
  response: `Network status check: ${now.toLocaleString()}`
};

console.log(JSON.stringify(response));
```

**Weather Script (daily-weather.py)**:
```python
#!/usr/bin/env python3
import json
import urllib.request

try:
    url = "https://wttr.in/YourCity?format=3"
    with urllib.request.urlopen(url, timeout=5) as response:
        weather = response.read().decode('utf-8').strip()
    output = {"response": weather}
except Exception as e:
    output = {"response": "Weather unavailable"}

print(json.dumps(output))
```

## Geofence Trigger Scripts {#geofence-trigger-scripts}

A [Geofence Trigger](/features/automation-triggers#geofence-triggers) runs its script when a node crosses the fence.

**Environment variables:** `GEOFENCE_NAME`, `GEOFENCE_ID`, `GEOFENCE_EVENT` (`entry`, `exit` or `while_inside`), `NODE_NUM`, `NODE_ID`, `NODE_LAT`, `NODE_LON`, `DISTANCE_TO_CENTER` (km), `MESHTASTIC_IP`, `MESHTASTIC_PORT`, plus `NODE_LONG_NAME` / `NODE_SHORT_NAME` and `MM_LAT` / `MM_LON` when known.

Geofence triggers support passing command-line arguments to scripts via the **Arguments** field. This is particularly useful with the `remote-admin.py` script for automated node management.

**Example Arguments:**
- `--reboot` - Reboot node on geofence entry
- `--set lora.region US` - Change settings on exit
- `--dest {NODE_ID} --reboot` - Target the triggering node
- `--ip {IP} --dest {NODE_ID} --factory-reset` - Full reset with token expansion

**Available Tokens:**

| Token | Description | Example |
|-------|-------------|---------|
| `{NODE_ID}` | Triggering node ID | `!a1b2c3d4` |
| `{NODE_NUM}` | Triggering node number | `123456789` |
| `{LONG_NAME}` | Node's long name | `Alice's Node` |
| `{SHORT_NAME}` | Node's short name | `ALI` |
| `{NODE_LAT}` | Node's latitude | `40.7128` |
| `{NODE_LON}` | Node's longitude | `-74.0060` |
| `{GEOFENCE_NAME}` | Geofence name | `Base Camp` |
| `{EVENT}` | Event type | `entry` |
| `{DISTANCE_TO_CENTER}` | Distance in km | `2.5` |
| `{IP}` | Meshtastic node IP | `192.168.1.100` |
| `{PORT}` | Meshtastic TCP port | `4403` |
| `{VERSION}` | MeshMonitor version | `v3.4.0` |
| `{NODECOUNT}` | Active node count | `42` |

**Example Configurations:**

| Use Case | Script | Arguments |
|----------|--------|-----------|
| Reboot on entry | remote-admin.py | `--reboot` |
| Change region on exit | remote-admin.py | `--set lora.region US` |
| Set position | remote-admin.py | `--setlat 40.7128 --setlon -74.0060` |
| Factory reset | remote-admin.py | `--factory-reset` |
| Custom with tokens | remote-admin.py | `--dest {NODE_ID} --set device.role CLIENT` |

**Example: Reboot Node on Geofence Entry**
```
Name: Reboot on Entry
Shape: Circle (500m radius)
Event: Entry
Response Type: Script
Script: /data/scripts/remote-admin.py
Arguments: --reboot
Channel: Direct Message
```

## Automation Engine Scripts {#automation-engine-scripts}

The Engine's [Run a script](/features/automation-engine-reference#run-a-script) action runs a script from the same folder.

- **Environment variables:** `MM_TRIGGER_TYPE`, `MM_SOURCE_ID`, `MM_TIMESTAMP`, `MM_NODE_NUM` (when the event has a node), and every trigger field as `MM_<UPPER_SNAKE_NAME>` (objects as JSON). For older scripts it also sets `MESSAGE`, `FROM_NODE`, `PACKET_ID`, `CHANNEL`, `SNR` and `RSSI` when the trigger has them.
- **Arguments** take Engine templates such as <code v-pre>{{ trigger.from }}</code>, not the `{IP}`-style tokens above.
- The script's output is **not** sent. Store it with **Store result in**, then send it with a **Send a message** action.

## API Reference

### /api/scripts Endpoint

**Method:** GET
**Authentication:** None (public endpoint)
**Response:**
```json
{
  "scripts": [
    {
      "path": "/data/scripts/weather.py",
      "filename": "weather.py",
      "name": "Weather Lookup",
      "emoji": "🌤️",
      "language": "Python"
    },
    {
      "path": "/data/scripts/info.sh",
      "filename": "info.sh",
      "name": "System Info",
      "emoji": "ℹ️",
      "language": "Shell"
    },
    {
      "path": "/data/scripts/hello.js",
      "filename": "hello.js",
      "language": "JavaScript"
    }
  ]
}
```

**Response Fields:**

| Field | Description | Always Present |
|-------|-------------|----------------|
| `path` | Full path to the script | Yes |
| `filename` | Script filename | Yes |
| `name` | Script name from mm_meta | No (only if mm_meta present) |
| `emoji` | Script emoji from mm_meta | No (only if mm_meta present) |
| `language` | Script language (from mm_meta or auto-detected from extension) | Yes |

This endpoint is called automatically by the Auto Responder UI to populate the script dropdown. Scripts with metadata display enhanced information in the UI.

## Support

For issues, questions, or feature requests:
- **GitHub Issues:** https://github.com/Yeraze/meshmonitor/issues
- **Documentation:** [Auto Responder](/features/automation-messages#auto-responder), [Automation Engine](/features/automation-engine)
- **Examples:** https://github.com/Yeraze/meshmonitor/tree/main/examples/auto-responder-scripts

## License

MeshMonitor is licensed under the BSD 3-Clause License. See [LICENSE](https://github.com/Yeraze/meshmonitor/blob/main/LICENSE) for details.
