# Native AI Bot

MeshMonitor includes a built-in AI bot that listens to Meshtastic channels and responds using a language model. Unlike the [external AI Responder sidecar](../add-ons/ai-responder), this bot is fully integrated into MeshMonitor — no additional containers required.

## Overview

The Native AI Bot is configured entirely from the **Automation → AI Bot** tab in the MeshMonitor UI. It supports:

- **OpenAI** (GPT-4o-mini, GPT-4o, etc.)
- **Ollama** (local models — llama3.2, mistral, gemma, etc.)
- **OpenRouter** (access to 100+ models via single API)

Messages addressed to the bot trigger an LLM query; the response is sent back as a DM to the sender, trimmed to fit Meshtastic packet limits.

## Configuration

### Provider & Model

| Setting | Description |
|---------|-------------|
| **Provider** | `openai`, `ollama`, or `openrouter` |
| **Model** | Model name (e.g. `gpt-4o-mini`, `llama3.2`, `google/gemini-flash-1.5`) |
| **API URL** | Endpoint URL — auto-filled per provider, change for custom proxies |
| **API Key** | Required for OpenAI/OpenRouter. Ollama needs no key. |

### Trigger & Channels

| Setting | Description |
|---------|-------------|
| **Trigger Word** | Message must start with this word (default: `bot`). E.g. `bot what's the weather?` |
| **Listen Channels** | Which channel indices to monitor |
| **Listen DMs** | If enabled, DMs are answered without needing the trigger word |
| **Cooldown** | Minimum seconds between replies per node (prevents flooding) |
| **Skip Incomplete Nodes** | Ignore messages from nodes with no name |

### System Prompt

The system prompt defines the bot's personality and constraints. Available tokens:

| Token | Replaced with |
|-------|---------------|
| `{LONG_NAME}` | Sender's long name |
| `{SHORT_NAME}` | Sender's short name |
| `{NODECOUNT}` | Total nodes visible on the mesh |

**Tip:** Always instruct the bot to keep replies under 200 characters — Meshtastic packets have tight size limits.

Default prompt:
```
You are a helpful assistant on a Meshtastic mesh radio network.
Keep responses very short (under 200 chars).
The user is {LONG_NAME} ({SHORT_NAME}).
```

### Advanced Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Max Tokens** | 150 | LLM token budget for the response |
| **Max Response Chars** | 200 | Response truncated to this before sending to mesh |
| **Temperature** | 0.7 | 0 = deterministic, 1 = creative, 2 = very creative |
| **Context Messages** | 3 | Previous messages included for conversation context |
| **Append Node Info** | true | Appends hop count, SNR, battery level to system prompt |

## Live Test

The **Live Test** panel lets you test the bot without sending anything to the mesh. It uses the current (unsaved) settings, so you can validate provider credentials and prompt tuning before enabling.

## How It Works

```
Node sends "bot what is LoRa?"
         │
         ▼
   MeshMonitor backend
   (meshtasticManager)
         │
         ├─ trigger word matched?
         ├─ channel allowed?
         ├─ node not on cooldown?
         │
         ▼
   LLM API call
   (OpenAI / Ollama / OpenRouter)
         │
         ▼
   Response truncated to maxChars
         │
         ▼
   DM sent back to sender via mesh
```

## Comparison: Native Bot vs AI Responder Sidecar

| Feature | Native AI Bot | AI Responder Sidecar |
|---------|--------------|----------------------|
| Installation | Built-in, zero setup | Extra Docker container |
| Providers | OpenAI, Ollama, OpenRouter | OpenAI, Gemini, Anthropic, Ollama |
| Session mode (DM conversations) | Not yet | Yes |
| Conversation history per user | Context window only | Persistent file storage |
| Admin commands | No | Yes (`!ai -p`) |
| UI configuration | Full MeshMonitor UI | Environment variables |
| Recommended for | Quick setup, small meshes | Feature-rich deployments |

## Related

- [AI Responder Sidecar](../add-ons/ai-responder) — full-featured external add-on
- [Auto Responder](automation) — keyword-triggered responses without an LLM
- [Automation Overview](automation) — all automation features
