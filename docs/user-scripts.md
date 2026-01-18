# MeshMonitor User Scripts Gallery

Discover community-contributed Auto Responder scripts for MeshMonitor! These scripts extend the functionality of MeshMonitor's Auto Responder feature, allowing you to create custom automated responses to messages.

::: tip Want to submit your script?
Have you created a useful Auto Responder script? We'd love to feature it! **[File an issue on GitHub](https://github.com/yeraze/meshmonitor/issues/new?title=User%20Script%20Submission&body=Please%20add%20my%20Auto%20Responder%20script%20to%20the%20User%20Scripts%20Gallery%3A%0A%0A**Script%20Name**%3A%20%0A**Description**%3A%20%0A**Language**%20(Python%2FJavaScript%2FShell)%3A%20%0A**Tags**%20(comma-separated)%3A%20%0A**Example%20Trigger**%3A%20%0A**Requirements**%3A%20%0A**GitHub%20Link%20or%20Gist**%3A%20%0A%0A%5BPaste%20your%20script%20code%20here%20or%20link%20to%20it%5D)** to request your script be added to the gallery.
:::

## Browse Scripts

<UserScriptsGallery />

## About User Scripts

User Scripts are custom scripts that integrate with MeshMonitor's Auto Responder feature. They can be written in:

- **Python** - Full-featured scripts with access to Python's extensive ecosystem
- **JavaScript/Node.js** - Modern JavaScript with Node.js APIs
- **Shell** - Simple shell scripts for quick automation

### What Scripts Can Do

- Respond to messages with custom logic
- Extract parameters from trigger patterns
- Call external APIs (weather, data, etc.)
- Perform system operations
- Return single or multiple responses
- Access environment variables and message context

## Guidelines for Submission

When submitting a script for the gallery, please provide:

1. **Script Name**: A clear, descriptive name
2. **Icon** (optional): An emoji or Unicode character to represent your script (e.g., 🌤️, 🤖, 📋)
3. **Description**: What the script does and its use case
4. **Language**: Python, JavaScript, or Shell
5. **Tags**: Relevant categories (e.g., "Weather", "API", "System", "Example")
6. **Example Trigger**: The trigger pattern(s) used with the script
7. **Requirements**: Any dependencies, API keys, or environment variables needed (can be a list)
8. **Code**: The complete script code (via GitHub link, Gist, or paste)
9. **Source Location**:
   - If in main repo: Script will be added to `examples/auto-responder-scripts/`
   - If in external repo: Provide GitHub path in format `USERNAME/repo/path/to/script.py` or `USERNAME/repo/branch/path/to/script.py`

### Script Metadata (mm_meta)

We recommend including a `mm_meta:` block in your script for enhanced display in the MeshMonitor UI:

```python
#!/usr/bin/env python3
# mm_meta:
#   name: My Script Name
#   emoji: 🔧
#   language: Python
```

Scripts with metadata display their name and emoji in dropdowns instead of just the file path. See the [Auto Responder Scripting Guide](/developers/auto-responder-scripting#script-metadata-mm-meta) for details.

### Script Requirements

All scripts must:

- Be located in `/data/scripts/` directory
- Have a supported extension: `.js`, `.mjs`, `.py`, or `.sh`
- Output valid JSON to stdout with a `response` field (or `responses` array)
- Complete within 10 seconds (timeout)
- Be executable (`chmod +x`)

### Output Format

Scripts must output JSON to stdout:

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
    "Second message (max 200 chars)"
  ]
}
```

## Getting Started

1. **Choose a script** from the gallery above
2. **View the source** to see the implementation
3. **Copy the script** to your local `./scripts/` directory
4. **Make it executable**: `chmod +x ./scripts/YourScript.py`
5. **Configure in MeshMonitor**:
   - Navigate to **Settings → Automation → Auto Responder**
   - Click **"Add Trigger"**
   - Set the trigger pattern (see script's example trigger)
   - Select **"Script"** as response type
   - Enter the script path: `/data/scripts/YourScript.py`
6. **Test your trigger** by sending a message matching the pattern

## Environment Variables

All scripts receive these environment variables:

- `MESSAGE`: Full message text received
- `FROM_NODE`: Sender's node number
- `FROM_SHORT_NAME`: Sender's short name (if known)
- `FROM_LONG_NAME`: Sender's long name (if known)
- `FROM_LAT`: Sender's latitude (if known)
- `FROM_LON`: Sender's longitude (if known)
- `MM_LAT`: MeshMonitor node's latitude (if known)
- `MM_LON`: MeshMonitor node's longitude (if known)
- `PACKET_ID`: Message packet ID
- `TRIGGER`: The trigger pattern that matched
- `PARAM_*`: Extracted parameters from trigger pattern (e.g., `PARAM_name`, `PARAM_location`)
- `TZ`: Server timezone (IANA timezone name)

## Source Code Location

Scripts can be hosted in two locations:

### Main Repository (examples/ directory)

Scripts added directly to the main MeshMonitor repository are stored in `examples/auto-responder-scripts/` and use the path format:
```
examples/auto-responder-scripts/YourScript.py
```

These scripts are rendered directly from the main repository.

### External User Repositories

Scripts hosted in external GitHub repositories use the path format:
```
USERNAME/repo/path/to/script.py
```

Or with a specific branch:
```
USERNAME/repo/branch/path/to/script.py
```

**Examples:**
- `username/meshmonitor_user-scripts/scripts/MyScript.py` (uses main branch)
- `username/meshmonitor_user-scripts/develop/scripts/MyScript.py` (uses develop branch)

External scripts are fetched from the external repository's raw GitHub URL. The system automatically detects whether a script is in the main repo (starts with `examples/`) or an external repo and handles fetching accordingly.

## Documentation

For detailed information on creating Auto Responder scripts, see:

- [Auto Responder Scripting Guide](/developers/auto-responder-scripting) - Complete developer documentation
- [Automation Features](/features/automation) - User-facing Auto Responder documentation
- [Example Scripts README](https://github.com/yeraze/meshmonitor/blob/main/examples/auto-responder-scripts/README.md) - Detailed examples and patterns

## Join the Community

Creating useful scripts? You're helping to grow the MeshMonitor ecosystem! Connect with other developers:

- **GitHub**: [github.com/yeraze/meshmonitor](https://github.com/yeraze/meshmonitor)
- **Issues & Discussions**: Share your scripts and learn from others
- **Pull Requests**: Submit improvements to existing scripts

---

*Note: Scripts listed here are community-contributed. The MeshMonitor project does not endorse or guarantee the security or functionality of listed scripts. Always review code before using in production.*

