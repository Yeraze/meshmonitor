# Analytics Integration

MeshMonitor supports optional web analytics to help you understand how your instance is being used. You can choose from several popular analytics providers or inject a custom tracking script.

::: warning Privacy Notice
Enabling analytics will send visitor data to the selected third-party service. Only enable this if you control this instance and comply with applicable privacy regulations (GDPR, CCPA, etc.).
:::

## Supported Providers

| Provider | Configuration Required |
|----------|----------------------|
| **Google Analytics (GA4)** | Measurement ID (e.g., `G-XXXXXXXXXX`) |
| **Cloudflare Web Analytics** | Beacon Token |
| **PostHog** | API Key + API Host URL |
| **Plausible** | Domain |
| **Umami** | Website ID + Script URL |
| **Matomo** | Matomo URL + Site ID |
| **Custom Script** | Full `<script>...</script>` block |

## Configuration

1. Navigate to **Settings** (admin access required)
2. Scroll to the **Analytics** section
3. Select your analytics provider from the dropdown
4. Fill in the required configuration fields for your chosen provider
5. Click **Save**

The analytics script is automatically injected into the HTML served to all visitors. Changes take effect immediately after saving - no container restart is required.

### Google Analytics (GA4)

Enter your **Measurement ID** in the format `G-XXXXXXXXXX`. You can find this in your Google Analytics property settings under Data Streams.

### Cloudflare Web Analytics

Enter your **Beacon Token** from the Cloudflare dashboard. Navigate to your site's Analytics & Logs > Web Analytics to find it.

### PostHog

Provide your **API Key** (starts with `phc_...`) and the **API Host** URL for your PostHog instance (e.g., `https://app.posthog.com` for cloud, or your self-hosted URL).

### Plausible

Enter the **Domain** exactly as configured in your Plausible dashboard (e.g., `meshmonitor.example.com`).

### Umami

Provide the **Website ID** from your Umami dashboard and the **Script URL** pointing to your Umami tracking script (e.g., `https://umami.example.com/script.js`).

### Matomo

Enter your **Matomo URL** (e.g., `https://matomo.example.com`) and the **Site ID** assigned to your site in Matomo.

### Custom Script

Paste the complete `<script>...</script>` block from any analytics provider not listed above. The script must start with `<script` and end with `</script>`.

When using a custom script, you can optionally specify **CSP Allowed Domains** - a space or comma-separated list of origins (e.g., `https://analytics.example.com`) that need to be allowed through the Content Security Policy.

## Content Security Policy (CSP)

MeshMonitor automatically updates its Content Security Policy to allow the selected analytics provider's domains. This means:

- **Built-in providers**: CSP domains are configured automatically. No action needed.
- **Custom scripts**: You must specify the domains your script needs in the **CSP Allowed Domains** field, or the browser will block the script.

## Access Control

- Only **admin users** can configure analytics settings
- Analytics scripts are served to **all visitors** once configured
- The setting is stored server-side and applies instance-wide
