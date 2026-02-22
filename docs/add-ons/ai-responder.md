# AI Responder

The AI Responder is an optional sidecar container that transforms your Meshtastic node into an AI-powered assistant. Users on the mesh can ask questions, have conversations, and get intelligent responses — all through standard Meshtastic messaging.

::: tip Credit
The AI Responder was created by [LN4CY](https://github.com/LN4CY/ai-responder). MeshMonitor integrates it as an optional Docker sidecar.
:::

## Overview

The AI Responder connects to MeshMonitor's Virtual Node (port 4404) and monitors configured channels for messages prefixed with `!ai`. It supports multiple AI providers — from local models via Ollama for privacy-focused deployments, to cloud providers like Google Gemini, OpenAI, and Anthropic for more powerful responses.

Key features:
- **Multi-provider support**: Ollama (local), Google Gemini, OpenAI, Anthropic Claude
- **Per-user conversation history**: Each user gets isolated conversation context
- **Session mode**: Continuous conversations in DMs without repeating the `!ai` prefix
- **Mesh-optimized**: Responses tuned for LoRa message size limits (~200 characters)
- **Automatic reconnection**: Resilient connection with 10-second retry loop

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                     Your Server                         │
│                                                         │
│  ┌────────────────┐     ┌──────────────┐                │
│  │  MeshMonitor   │────►│ AI Responder │                │
│  │  (port 3001)   │     │  (sidecar)   │                │
│  │                │     │              │                │
│  │  Virtual Node  │◄────│  TCP Client  │                │
│  │  (port 4404)   │     │              │───► AI Provider│
│  └────────┬───────┘     └──────────────┘    (Ollama,   │
│           │                                  Gemini,   │
│           │                                  OpenAI,   │
│           │                                  Claude)   │
└───────────┼─────────────────────────────────────────────┘
            │
            │ TCP (port 4403)
            ▼
    ┌───────────────┐
    │  Meshtastic   │
    │    Node       │
    └───────────────┘
```

**Key Points:**
1. The AI Responder connects to MeshMonitor's Virtual Node (port 4404)
2. It monitors configured channels for `!ai` messages
3. Questions are forwarded to the configured AI provider
4. Responses are sent back through the mesh network

## Quick Start

### Prerequisites

1. **Virtual Node enabled** — The AI Responder requires MeshMonitor's Virtual Node feature (`ENABLE_VIRTUAL_NODE=true`)
2. **AI provider** — Either a local Ollama instance or a cloud API key (Gemini, OpenAI, or Anthropic)

### Docker Compose Setup

Add the AI Responder to your existing `docker-compose.yml`:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    # ... your existing MeshMonitor configuration ...
    environment:
      - ENABLE_VIRTUAL_NODE=true
      - VIRTUAL_NODE_PORT=4404
      # ... other environment variables ...

  # AI Responder - AI-powered mesh assistant
  # Credit: https://github.com/LN4CY/ai-responder
  ai-responder:
    image: ghcr.io/ln4cy/ai-responder:latest
    container_name: meshmonitor-ai-responder
    restart: unless-stopped
    environment:
      - INTERFACE_TYPE=tcp
      - MESHTASTIC_HOST=meshmonitor
      - MESHTASTIC_PORT=4404
      - AI_PROVIDER=ollama           # or: gemini, openai, anthropic
      - OLLAMA_HOST=ollama           # if using Ollama
      - ADMIN_NODE_ID=!your_admin_id # your node ID for admin commands
      - ALLOWED_CHANNELS=0           # comma-separated channel indices
    volumes:
      - ai-data:/app/data
    depends_on:
      - meshmonitor

  # Optional: Local AI with Ollama
  ollama:
    image: ollama/ollama:latest
    container_name: meshmonitor-ollama
    restart: unless-stopped
    volumes:
      - ollama-data:/root/.ollama

volumes:
  ai-data:
  ollama-data:
```

### Deploy and Initialize

```bash
# Start the stack
docker compose up -d

# If using Ollama, pull a model
docker exec -it meshmonitor-ollama ollama pull llama3.2:1b
```

## Configuration Options

The AI Responder is configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERFACE_TYPE` | `tcp` | Connection type: `tcp` or `serial` |
| `MESHTASTIC_HOST` | `meshmonitor` | Hostname of MeshMonitor (use Docker service name) |
| `MESHTASTIC_PORT` | `4404` | Virtual Node port |
| `AI_PROVIDER` | `ollama` | AI provider: `ollama`, `gemini`, `openai`, or `anthropic` |
| `OLLAMA_HOST` | `ollama` | Ollama service hostname (when using Ollama) |
| `GEMINI_API_KEY` | - | Google Gemini API key |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `ANTHROPIC_API_KEY` | - | Anthropic API key |
| `ADMIN_NODE_ID` | - | Node ID with admin privileges (e.g., `!1234abcd`) |
| `ALLOWED_CHANNELS` | `0,3` | Comma-separated list of channel indices to monitor |
| `HISTORY_MAX_MESSAGES` | `1000` | Maximum stored messages per user |
| `HISTORY_MAX_BYTES` | `2097152` | Maximum history file size (bytes) |
| `CHUNK_DELAY` | `15` | Seconds between message chunks |
| `CONNECTION_RETRY_INTERVAL` | `10` | Seconds between reconnection attempts |

## Supported AI Providers

| Provider | Type | Best For |
|----------|------|----------|
| **Ollama** | Local | Privacy-focused deployments, no internet required |
| **Google Gemini** | Cloud | Powerful responses with optional grounding (search/maps) |
| **OpenAI** | Cloud | GPT-powered responses |
| **Anthropic** | Cloud | Claude-powered responses |

Admins can switch providers at runtime using the `!ai -p` command.

## User Commands

### Basic Usage

| Command | Description |
|---------|-------------|
| `!ai <question>` | Ask a question (required in channels, one-off in DMs) |
| `!ai -h` | Show help menu |

### Session Management (DM Only)

| Command | Description |
|---------|-------------|
| `!ai -n [name]` | Start a continuous conversation session |
| `!ai -end` | End the active session |

Sessions allow back-and-forth conversation in DMs without repeating the `!ai` prefix. They auto-timeout after 5 minutes of inactivity.

### Conversation History

| Command | Description |
|---------|-------------|
| `!ai -c ls` | List saved conversations (max 10 slots per user) |
| `!ai -c [name/number]` | Load a previous conversation |
| `!ai -c rm [name/number]` | Delete a specific conversation |
| `!ai -c rm all` | Clear all saved conversations |
| `!ai -m` | Show context usage and storage stats |

### Admin Commands

| Command | Description |
|---------|-------------|
| `!ai -p` | List available AI providers |
| `!ai -p [provider]` | Switch AI provider (admin only) |

## Channel vs. DM Behavior

| Feature | Channel | DM |
|---------|---------|-----|
| `!ai` prefix required | Every message | First message only (in session) |
| Session mode | Not available | Available via `!ai -n` |
| Conversation history | Per-channel, per-user | Per-user |
| Slot usage | Does not count | Uses 1 of 10 slots |

## Troubleshooting

### Checking Logs

```bash
docker compose logs ai-responder -f
```

### Common Issues

#### "Connection refused" or "Cannot connect"
- Ensure MeshMonitor is running and Virtual Node is enabled
- Verify `MESHTASTIC_HOST` matches your MeshMonitor service name
- Check that `MESHTASTIC_PORT` matches your Virtual Node port (default: 4404)

#### No response to `!ai` messages
- Verify the channel index is in `ALLOWED_CHANNELS`
- Check that the AI provider is configured correctly
- If using Ollama, ensure a model has been pulled (`docker exec ollama ollama list`)

#### Slow or truncated responses
- LoRa messages are limited in size; responses are automatically chunked
- Adjust `CHUNK_DELAY` if responses are being dropped
- Cloud providers generally give faster responses than local Ollama

#### Provider API errors
- Verify your API key is correct for the selected provider
- Check that the provider service is reachable from the container
- Review logs for specific error messages

## Related Documentation

- [Virtual Node](/configuration/virtual-node) - Required for AI Responder
- [MQTT Client Proxy](/add-ons/mqtt-proxy) - Another community add-on by LN4CY
- [Community Add-ons Overview](/add-ons/) - All available add-ons
- [LN4CY ai-responder Repository](https://github.com/LN4CY/ai-responder) - Full documentation and source code
