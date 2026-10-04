# Message Translation

MeshMonitor includes native inline chat message translation for mesh broadcast channels and direct messages. This allows operators and mesh communities across different regions and languages to communicate seamlessly over radio networks.

---

## Overview

Message translation in MeshMonitor operates on-demand:
- **Inbound Messages**: Hover over any received message in a channel or direct message thread and click the **Translate** icon to view the translated text inline directly below the message.
- **Outbound Composer**: Click the **Translate** icon in the message compose bar to translate your draft into a destination language before transmitting over the mesh network.
- **Language Switcher**: Dynamically change the destination language right on the message card, with choices automatically remembered for future translations.
- **LoRa Packet Awareness**: Real-time UTF-8 byte counting warns you if translated text exceeds typical radio packet limits (~200–220 bytes).

---

## Supported Translation Providers

MeshMonitor supports four flexible translation backends, catering to cloud APIs, self-hosted open-source software, and completely offline local language models:

| Provider | Cost / Tier | Hosting | Setup Complexity | Best For |
| :--- | :--- | :--- | :--- | :--- |
| **DeepL API** <br>*(Recommended)* | **Free** (500k chars/mo) or Paid Pro | Cloud | **Easiest** | **Recommended.** Easiest setup. High translation quality. Free developer account requires no payment details. |
| **LibreTranslate** | **Free & Open Source** | Local (Docker) or Cloud | Low | Offline/air-gapped nodes, self-hosted servers, privacy-focused deployments. |
| **OpenAI-Compatible** | **Free** (Local Ollama) or Pay-per-token (OpenAI, OpenRouter, vLLM) | Local or Cloud | Low–Medium | Flexible LLM-based translations, local Ollama models (`llama3`, `qwen2.5`), or cloud LLMs. |
| **Google Cloud Translation** | Free trial / Pay-as-you-go | Cloud | Medium | Users with existing Google Cloud Console infrastructure. |

---

## Recommended: Setting Up DeepL API (Free)

For most users, **DeepL API Free** provides the best balance of speed, translation accuracy, and ease of setup:

1. Sign up for a free DeepL API developer account at [deepl.com/pro-api](https://www.deepl.com/pro-api) (select the **DeepL API Free** plan).
2. Copy your **Authentication Key** from your DeepL account dashboard (Free keys end in `:fx`, such as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx`).
3. In MeshMonitor, navigate to **Settings** → **Message Translation**.
4. Check **Enable Message Translation**.
5. Select **DeepL API (Free / Pro)** from the **Translation Provider** dropdown.
6. Paste your authentication key into the **DeepL Auth Key** field.
7. Leave **API URL** blank.
8. Click **Test Connection** to verify connectivity.
9. Click **Save Changes** in the bottom save bar.

::: tip Automatic Endpoint Detection
MeshMonitor automatically detects whether your DeepL key is Free (`:fx`) or Pro and routes requests to the correct API endpoint (`https://api-free.deepl.com/v2` vs `https://api.deepl.com/v2`). If using a custom reverse proxy or enterprise gateway, you can enter a custom URL in the **Custom DeepL Base URL** field.
:::

---

## Setting Up OpenAI or OpenAI-Compatible APIs

MeshMonitor supports **OpenAI** and OpenAI-compatible providers (such as [OpenRouter](https://openrouter.ai/), Groq, Together AI, etc...), and local inference engines (such as [Ollama](https://ollama.com/) or vLLM).

### Using the Official OpenAI API

1. Create an account at the [OpenAI Platform](https://platform.openai.com/).
2. Generate an API secret key from the [OpenAI API Keys Dashboard](https://platform.openai.com/api-keys). For full API details and rate limits, consult the [OpenAI API Documentation](https://platform.openai.com/docs).
3. In MeshMonitor under **Settings** → **Message Translation**:
   - Set **Translation Provider** to `OpenAI-Compatible (Ollama, OpenRouter, OpenAI, vLLM)`.
   - Set **OpenAI URL** to `https://api.openai.com/v1/chat/completions`.
   - Set **Model Name** to `gpt-4o-mini` (or `gpt-4o`).
   - Paste your key (`sk-...`) into the **API Key** field.
4. Click **Test Connection** and then **Save Changes**.

---

## Local & Offline Options

If your MeshMonitor node operates in an off-grid, air-gapped, or privacy-conscious environment without internet access, you can run a local translation engine on the same host or local network:

### 1. LibreTranslate (Self-Hosted Open Source)

[LibreTranslate](https://libretranslate.com/) is a free, self-hosted, open-source machine translation engine powered by Argos Translate.

- **Project Website**: [libretranslate.com](https://libretranslate.com/)
- **Source Code**: [GitHub - LibreTranslate/LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)
- **Documentation**: For full installation options, language model management, and GPU acceleration setup, refer to the official [LibreTranslate Documentation](https://libretranslate.com/).

You can quickly launch a local instance using Docker:

```bash
docker run -d -p 5000:5000 --restart always libretranslate/libretranslate
```

In MeshMonitor:
- Set **Translation Provider** to `LibreTranslate (Local / Self-Hosted / Cloud)`.
- Set **LibreTranslate URL** to `http://localhost:5000` (or leave blank to use the default `http://libretranslate:5000`).
- Leave the API key blank if authentication is not enabled on your instance.

### 2. Ollama / Local Language Models

If you run [Ollama](https://ollama.com/) or another OpenAI-compatible local inference server:

```bash
ollama run llama3.2
```

In MeshMonitor:
- Set **Translation Provider** to `OpenAI-Compatible (Ollama, OpenRouter, OpenAI, vLLM)`.
- Set **OpenAI Base URL** to `http://host.docker.internal:11434/v1` (or leave blank to use the default `http://host.docker.internal:11434/v1/chat/completions`).
- Set **Model Name** to your desired model (e.g. `llama3.2`, `qwen2.5`, or `mistral`).
- Leave the API key blank for local Ollama instances.

---

## Endpoint URL Configuration Rules

When configuring custom service URLs for LibreTranslate, OpenAI-compatible backends, or DeepL custom gateways, MeshMonitor applies the following resolution rules:

- **Leave Blank**: Uses the provider's default endpoint.
- **Bare Origin** (e.g. `http://localhost:5000` or `http://localhost:11434`): The provider's standard default path (such as `/translate`, `/v1/chat/completions`, or `/v2/translate`) is automatically appended.
- **Version Base Path** (e.g. `http://host.docker.internal:11434/v1` or `https://api.deepl.com/v2`): Automatically appends the required subpath (`/chat/completions` or `/translate`).
- **Full Endpoint / Custom Path** (e.g. `https://my-proxy.internal/v1/custom-translate` or `https://api.openai.com/v1/chat/completions`): Used verbatim as the full request destination.
- **No Protocol Specified** (e.g. `localhost:5000`): Automatically adopts the default protocol (`http://` or `https://`) for that provider.

---

## How to Use Translation

### Inbound Message Translation
1. In the **Channels** or **Messages** tab, hover over any message.
2. Click the **Translate** icon on the message toolbar.
3. The message is translated into your primary language (configured in settings or your last chosen language).
4. To switch the target language, select a new language from the inline dropdown on the translated banner. MeshMonitor will re-translate the message and remember your preference in your browser's local storage.
5. Click the close (**✕**) icon to hide the translation banner at any time.

### Outbound Message Translation
1. Type a message in the chat composer input box.
2. Click the **Translate** icon to the right of the compose box.
3. The **Translate Outgoing Message** modal will appear with your text pre-populated.
4. Select your **Source Language** (or keep *Auto-detect*) and choose the **Target Language**.
5. Use the **⇄** (swap) button if you need to reverse the language direction.
6. Click **Translate**.
7. Review the translation and check the byte counter.
8. Click **Replace in Draft** to insert the translated text directly into the compose box ready for transmission.

---

## Radio Constraints & Byte Limits

LoRa packet payloads are typically constrained to approximately **200 to 220 UTF-8 bytes** depending on modem presets and packet metadata.

- The outbound translation modal features a real-time UTF-8 byte counter showing current payload usage (e.g., `45 / 200 bytes`).
- If a translation exceeds the 200-byte threshold, a **LoRa Packet Payload Warning** banner appears in the modal advising you to shorten the text before transmitting over RF.

---

## Security & Privacy

- **Authentication & Permission Gating**: Translation endpoints (`POST /api/translate` and `POST /api/v1/translate`) require an authenticated user with `messages:read` permission. Unauthenticated visitors or users lacking message permissions cannot access translation endpoints, and translation action buttons are hidden in the UI.
- **Dedicated Rate Limiting**: Translation endpoints are protected by a dedicated user/IP rate limiter (`RATE_LIMIT_TRANSLATE`, defaulting to 30 requests/minute in production and 120 in development) to defend provider API quota against automated loops and excessive usage.
- **Secret Masking**: Sensitive translation API keys and authentication tokens are stored securely server-side and automatically stripped from `GET /api/settings` for non-admin viewers.
- **Admin Gating**: Connection testing (`POST /api/translate/test`) requires administrative privileges (`requireAdmin()`).
- **Telemetry Filtering**: Raw telemetry packets, system status logs, emojis, and standard radio pings (`ack`, `ping`, `test`, `73`) are automatically detected and filtered out to prevent unnecessary API queries and costs.
- **Payload Limits**: Inbound translation requests enforce a maximum character limit of 5,000 characters and include automatic request timeouts.
