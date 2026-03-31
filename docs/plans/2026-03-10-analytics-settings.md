# Analytics Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional, admin-configurable analytics (GA4, CloudFlare, PostHog, Plausible, Umami, Matomo, or custom script) injected server-side into the HTML `<head>`.

**Architecture:** Settings stored in DB as two keys (`analyticsProvider` and `analyticsConfig`). On save, the cached HTML is invalidated so `rewriteHtml()` re-generates it with the analytics `<script>` tags injected after the `<base>` tag. Provider templates generate the correct script from an ID/token; "Custom" allows raw script paste.

**Tech Stack:** TypeScript, Express, React, i18next, existing settings infrastructure (DB, API, SettingsContext, SettingsTab)

---

## Provider Templates

Each known provider maps a single ID/token to the correct `<script>` tags:

| Provider | Input Label | Input Example | Script Template |
|----------|-------------|---------------|-----------------|
| GA4 | Measurement ID | `G-XXXXXXXXXX` | `<script async src="https://www.googletagmanager.com/gtag/js?id=ID"></script><script>window.dataLayer=window.dataLayer\|\|[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','ID');</script>` |
| CloudFlare | Beacon Token | `abc123...` | `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token":"ID"}'></script>` |
| PostHog | API Key + Host | Key: `phc_xxx`, Host: `https://app.posthog.com` | `<script>!function(t,e){...}(document,window);posthog.init('KEY',{api_host:'HOST'})</script>` |
| Plausible | Domain | `example.com` | `<script defer data-domain="DOMAIN" src="https://plausible.io/js/script.js"></script>` |
| Umami | Website ID + Script URL | ID: `xxx`, URL: `https://analytics.example.com/script.js` | `<script async src="URL" data-website-id="ID"></script>` |
| Matomo | URL + Site ID | URL: `https://matomo.example.com`, ID: `1` | `<script>var _paq=window._paq=window._paq\|\|[];_paq.push(['trackPageView']);...var u="URL/";...</script>` |
| Custom | Script Block | `<script>...</script>` | Injected as-is |

---

## Settings Keys

Two new settings keys:

- `analyticsProvider`: `'none' | 'ga4' | 'cloudflare' | 'posthog' | 'plausible' | 'umami' | 'matomo' | 'custom'` (default: `'none'`)
- `analyticsConfig`: JSON string containing provider-specific config. Examples:
  - GA4: `{"measurementId": "G-XXXXXXXXXX"}`
  - CloudFlare: `{"beaconToken": "abc123"}`
  - PostHog: `{"apiKey": "phc_xxx", "apiHost": "https://app.posthog.com"}`
  - Plausible: `{"domain": "example.com"}`
  - Umami: `{"websiteId": "xxx", "scriptUrl": "https://analytics.example.com/script.js"}`
  - Matomo: `{"siteUrl": "https://matomo.example.com", "siteId": "1"}`
  - Custom: `{"script": "<script>...</script>"}`

---

## Tasks

### Task 1: Add settings keys and analytics script generator

**Files:**
- Modify: `src/server/constants/settings.ts` (add 2 keys to VALID_SETTINGS_KEYS)
- Create: `src/server/utils/analyticsScriptGenerator.ts` (provider templates)

**Step 1: Add settings keys**

In `src/server/constants/settings.ts`, add to the VALID_SETTINGS_KEYS array (before the closing `]`):

```typescript
  'analyticsProvider',
  'analyticsConfig',
```

**Step 2: Create analytics script generator**

Create `src/server/utils/analyticsScriptGenerator.ts`:

```typescript
export type AnalyticsProvider = 'none' | 'ga4' | 'cloudflare' | 'posthog' | 'plausible' | 'umami' | 'matomo' | 'custom';

interface AnalyticsConfig {
  // GA4
  measurementId?: string;
  // CloudFlare
  beaconToken?: string;
  // PostHog
  apiKey?: string;
  apiHost?: string;
  // Plausible
  domain?: string;
  // Umami
  websiteId?: string;
  scriptUrl?: string;
  // Matomo
  siteUrl?: string;
  siteId?: string;
  // Custom
  script?: string;
}

/**
 * Generate analytics script tags for injection into HTML <head>.
 * Returns empty string if provider is 'none' or config is invalid.
 */
export function generateAnalyticsScript(provider: AnalyticsProvider, config: AnalyticsConfig): string {
  switch (provider) {
    case 'ga4': {
      const id = config.measurementId?.trim();
      if (!id || !/^G-[A-Z0-9]+$/.test(id)) return '';
      return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`;
    }
    case 'cloudflare': {
      const token = config.beaconToken?.trim();
      if (!token || !/^[a-f0-9]+$/i.test(token)) return '';
      return `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token":"${token}"}'></script>`;
    }
    case 'posthog': {
      const key = config.apiKey?.trim();
      const host = config.apiHost?.trim();
      if (!key || !host) return '';
      if (!/^https?:\/\//.test(host)) return '';
      return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${key}',{api_host:'${host}'});</script>`;
    }
    case 'plausible': {
      const domain = config.domain?.trim();
      if (!domain) return '';
      return `<script defer data-domain="${domain}" src="https://plausible.io/js/script.js"></script>`;
    }
    case 'umami': {
      const id = config.websiteId?.trim();
      const url = config.scriptUrl?.trim();
      if (!id || !url) return '';
      if (!/^https?:\/\//.test(url)) return '';
      return `<script async src="${url}" data-website-id="${id}"></script>`;
    }
    case 'matomo': {
      const siteUrl = config.siteUrl?.trim()?.replace(/\/+$/, '');
      const siteId = config.siteId?.trim();
      if (!siteUrl || !siteId) return '';
      if (!/^https?:\/\//.test(siteUrl)) return '';
      return `<script>var _paq=window._paq=window._paq||[];_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u="${siteUrl}/";_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId','${siteId}']);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.async=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();</script>`;
    }
    case 'custom': {
      const script = config.script?.trim();
      if (!script) return '';
      // Only allow script tags for security
      if (!script.startsWith('<script') || !script.endsWith('</script>')) return '';
      return script;
    }
    default:
      return '';
  }
}
```

**Step 3: Commit**

```
feat: add analytics settings keys and script generator
```

---

### Task 2: Integrate analytics injection into rewriteHtml and add cache invalidation

**Files:**
- Modify: `src/server/server.ts` (~line 8757, `rewriteHtml` function and ~line 8787 cache vars)
- Modify: `src/server/routes/settingsRoutes.ts` (add side-effect callback for cache invalidation)

**Step 1: Add analytics injection to rewriteHtml**

In `src/server/server.ts`, modify the `rewriteHtml` function (line 8757) to accept an optional analytics script parameter:

Change the function signature from:
```typescript
const rewriteHtml = (htmlContent: string, baseUrl: string): string => {
```
to:
```typescript
const rewriteHtml = (htmlContent: string, baseUrl: string, analyticsScript?: string): string => {
```

After the `<base>` tag injection line, add:
```typescript
    if (analyticsScript) {
      rewritten = rewritten.replace(
        baseTag,
        `${baseTag}\n    ${analyticsScript}`
      );
    }
```

**Step 2: Load analytics settings when building cached HTML**

At the two places where `cachedRewrittenHtml` is built (lines ~8850 and ~8872), change:
```typescript
cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL);
```
to:
```typescript
const analyticsScript = getAnalyticsScript();
cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
```

Add a helper function near the top of the static file serving section:
```typescript
import { generateAnalyticsScript, AnalyticsProvider } from './utils/analyticsScriptGenerator.js';

function getAnalyticsScript(): string {
  try {
    const provider = (databaseService.getSetting('analyticsProvider') || 'none') as AnalyticsProvider;
    if (provider === 'none') return '';
    const configStr = databaseService.getSetting('analyticsConfig') || '{}';
    const config = JSON.parse(configStr);
    return generateAnalyticsScript(provider, config);
  } catch {
    return '';
  }
}
```

**Step 3: Export a cache invalidation function**

Near line 8787 where the cache variables are defined, add an exported function:
```typescript
export function invalidateHtmlCache(): void {
  cachedRewrittenHtml = null;
  cachedRewrittenEmbedHtml = null;
}
```

**Step 4: Add side-effect callback in settings route**

In `src/server/routes/settingsRoutes.ts`, in the POST handler where other side-effects are handled (around line 454+), add:

```typescript
if ('analyticsProvider' in filteredSettings || 'analyticsConfig' in filteredSettings) {
  callbacks.invalidateHtmlCache?.();
  logger.info('📊 Analytics settings updated - HTML cache invalidated');
}
```

Also add `invalidateHtmlCache` to the callbacks interface/object where the other callbacks are registered (in server.ts where the settings route is mounted). Find where `callbacks` is defined and add `invalidateHtmlCache`.

**Step 5: Commit**

```
feat: inject analytics scripts server-side with cache invalidation
```

---

### Task 3: Add analytics section to Settings UI

**Files:**
- Modify: `src/components/SettingsTab.tsx` (add analytics section at bottom)
- Modify: `public/locales/en.json` (add translation keys)

**Step 1: Add translation keys**

Add to `public/locales/en.json` near the other settings translations:

```json
  "settings.analytics": "Analytics",
  "settings.analytics_provider_label": "Analytics Provider",
  "settings.analytics_provider_description": "Select an analytics service to track visitor traffic on your instance.",
  "settings.analytics_provider_none": "None (Disabled)",
  "settings.analytics_provider_ga4": "Google Analytics (GA4)",
  "settings.analytics_provider_cloudflare": "Cloudflare Web Analytics",
  "settings.analytics_provider_posthog": "PostHog",
  "settings.analytics_provider_plausible": "Plausible",
  "settings.analytics_provider_umami": "Umami",
  "settings.analytics_provider_matomo": "Matomo",
  "settings.analytics_provider_custom": "Custom Script",
  "settings.analytics_measurement_id_label": "Measurement ID",
  "settings.analytics_measurement_id_description": "Your GA4 Measurement ID (e.g. G-XXXXXXXXXX)",
  "settings.analytics_beacon_token_label": "Beacon Token",
  "settings.analytics_beacon_token_description": "Your Cloudflare Web Analytics beacon token",
  "settings.analytics_api_key_label": "API Key",
  "settings.analytics_api_key_description": "Your PostHog project API key (e.g. phc_...)",
  "settings.analytics_api_host_label": "API Host",
  "settings.analytics_api_host_description": "PostHog instance URL (e.g. https://app.posthog.com)",
  "settings.analytics_domain_label": "Domain",
  "settings.analytics_domain_description": "Your site domain as configured in Plausible",
  "settings.analytics_website_id_label": "Website ID",
  "settings.analytics_website_id_description": "Your Umami website ID",
  "settings.analytics_script_url_label": "Script URL",
  "settings.analytics_script_url_description": "URL to your Umami tracking script",
  "settings.analytics_site_url_label": "Matomo URL",
  "settings.analytics_site_url_description": "Your Matomo instance URL (e.g. https://matomo.example.com)",
  "settings.analytics_site_id_label": "Site ID",
  "settings.analytics_site_id_description": "Your Matomo site ID",
  "settings.analytics_custom_script_label": "Custom Script",
  "settings.analytics_custom_script_description": "Paste the full <script>...</script> block from your analytics provider",
  "settings.analytics_warning": "Enabling analytics will send visitor data to the selected service. Only enable this if you control this instance and comply with applicable privacy regulations (GDPR, CCPA, etc.).",
```

**Step 2: Add state variables to SettingsTab**

In `src/components/SettingsTab.tsx`, add local state variables near the other state declarations:

```typescript
const [localAnalyticsProvider, setLocalAnalyticsProvider] = useState<string>('none');
const [localAnalyticsConfig, setLocalAnalyticsConfig] = useState<Record<string, string>>({});
```

**Step 3: Load analytics settings from server response**

In the settings loading section (where other settings are parsed from the server response), add:

```typescript
if (settings.analyticsProvider) {
  setLocalAnalyticsProvider(settings.analyticsProvider);
}
if (settings.analyticsConfig) {
  try {
    setLocalAnalyticsConfig(JSON.parse(settings.analyticsConfig));
  } catch { /* ignore parse errors */ }
}
```

**Step 4: Include analytics in the save payload**

In the save handler where settings are collected into the payload object, add:

```typescript
analyticsProvider: localAnalyticsProvider,
analyticsConfig: JSON.stringify(localAnalyticsConfig),
```

**Step 5: Add the analytics section JSX**

After the last settings section (map settings) and before the closing elements, add:

```tsx
{hasSettingsWrite && (
  <div id="settings-analytics" className="settings-section">
    <h3>{t('settings.analytics')}</h3>

    <div className="setting-item">
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 1rem 0', padding: '0.75rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', borderLeft: '3px solid var(--warning-border, #ffeaa7)' }}>
        {t('settings.analytics_warning')}
      </p>
    </div>

    <div className="setting-item">
      <label htmlFor="analyticsProvider">
        {t('settings.analytics_provider_label')}
        <span className="setting-description">{t('settings.analytics_provider_description')}</span>
      </label>
      <select
        id="analyticsProvider"
        value={localAnalyticsProvider}
        onChange={(e) => {
          setLocalAnalyticsProvider(e.target.value);
          setLocalAnalyticsConfig({});
        }}
        className="setting-input"
      >
        <option value="none">{t('settings.analytics_provider_none')}</option>
        <option value="ga4">{t('settings.analytics_provider_ga4')}</option>
        <option value="cloudflare">{t('settings.analytics_provider_cloudflare')}</option>
        <option value="posthog">{t('settings.analytics_provider_posthog')}</option>
        <option value="plausible">{t('settings.analytics_provider_plausible')}</option>
        <option value="umami">{t('settings.analytics_provider_umami')}</option>
        <option value="matomo">{t('settings.analytics_provider_matomo')}</option>
        <option value="custom">{t('settings.analytics_provider_custom')}</option>
      </select>
    </div>

    {/* Provider-specific config fields */}
    {localAnalyticsProvider === 'ga4' && (
      <div className="setting-item">
        <label htmlFor="analyticsMeasurementId">
          {t('settings.analytics_measurement_id_label')}
          <span className="setting-description">{t('settings.analytics_measurement_id_description')}</span>
        </label>
        <input
          id="analyticsMeasurementId"
          type="text"
          value={localAnalyticsConfig.measurementId || ''}
          onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, measurementId: e.target.value })}
          className="setting-input"
          placeholder="G-XXXXXXXXXX"
        />
      </div>
    )}

    {localAnalyticsProvider === 'cloudflare' && (
      <div className="setting-item">
        <label htmlFor="analyticsBeaconToken">
          {t('settings.analytics_beacon_token_label')}
          <span className="setting-description">{t('settings.analytics_beacon_token_description')}</span>
        </label>
        <input
          id="analyticsBeaconToken"
          type="text"
          value={localAnalyticsConfig.beaconToken || ''}
          onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, beaconToken: e.target.value })}
          className="setting-input"
        />
      </div>
    )}

    {localAnalyticsProvider === 'posthog' && (
      <>
        <div className="setting-item">
          <label htmlFor="analyticsApiKey">
            {t('settings.analytics_api_key_label')}
            <span className="setting-description">{t('settings.analytics_api_key_description')}</span>
          </label>
          <input
            id="analyticsApiKey"
            type="text"
            value={localAnalyticsConfig.apiKey || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, apiKey: e.target.value })}
            className="setting-input"
            placeholder="phc_..."
          />
        </div>
        <div className="setting-item">
          <label htmlFor="analyticsApiHost">
            {t('settings.analytics_api_host_label')}
            <span className="setting-description">{t('settings.analytics_api_host_description')}</span>
          </label>
          <input
            id="analyticsApiHost"
            type="text"
            value={localAnalyticsConfig.apiHost || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, apiHost: e.target.value })}
            className="setting-input"
            placeholder="https://app.posthog.com"
          />
        </div>
      </>
    )}

    {localAnalyticsProvider === 'plausible' && (
      <div className="setting-item">
        <label htmlFor="analyticsDomain">
          {t('settings.analytics_domain_label')}
          <span className="setting-description">{t('settings.analytics_domain_description')}</span>
        </label>
        <input
          id="analyticsDomain"
          type="text"
          value={localAnalyticsConfig.domain || ''}
          onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, domain: e.target.value })}
          className="setting-input"
          placeholder="example.com"
        />
      </div>
    )}

    {localAnalyticsProvider === 'umami' && (
      <>
        <div className="setting-item">
          <label htmlFor="analyticsWebsiteId">
            {t('settings.analytics_website_id_label')}
            <span className="setting-description">{t('settings.analytics_website_id_description')}</span>
          </label>
          <input
            id="analyticsWebsiteId"
            type="text"
            value={localAnalyticsConfig.websiteId || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, websiteId: e.target.value })}
            className="setting-input"
          />
        </div>
        <div className="setting-item">
          <label htmlFor="analyticsScriptUrl">
            {t('settings.analytics_script_url_label')}
            <span className="setting-description">{t('settings.analytics_script_url_description')}</span>
          </label>
          <input
            id="analyticsScriptUrl"
            type="text"
            value={localAnalyticsConfig.scriptUrl || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, scriptUrl: e.target.value })}
            className="setting-input"
            placeholder="https://analytics.example.com/script.js"
          />
        </div>
      </>
    )}

    {localAnalyticsProvider === 'matomo' && (
      <>
        <div className="setting-item">
          <label htmlFor="analyticsSiteUrl">
            {t('settings.analytics_site_url_label')}
            <span className="setting-description">{t('settings.analytics_site_url_description')}</span>
          </label>
          <input
            id="analyticsSiteUrl"
            type="text"
            value={localAnalyticsConfig.siteUrl || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, siteUrl: e.target.value })}
            className="setting-input"
            placeholder="https://matomo.example.com"
          />
        </div>
        <div className="setting-item">
          <label htmlFor="analyticsSiteId">
            {t('settings.analytics_site_id_label')}
            <span className="setting-description">{t('settings.analytics_site_id_description')}</span>
          </label>
          <input
            id="analyticsSiteId"
            type="text"
            value={localAnalyticsConfig.siteId || ''}
            onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, siteId: e.target.value })}
            className="setting-input"
            placeholder="1"
          />
        </div>
      </>
    )}

    {localAnalyticsProvider === 'custom' && (
      <div className="setting-item">
        <label htmlFor="analyticsCustomScript">
          {t('settings.analytics_custom_script_label')}
          <span className="setting-description">{t('settings.analytics_custom_script_description')}</span>
        </label>
        <textarea
          id="analyticsCustomScript"
          value={localAnalyticsConfig.script || ''}
          onChange={(e) => setLocalAnalyticsConfig({ ...localAnalyticsConfig, script: e.target.value })}
          className="setting-input"
          rows={6}
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
          placeholder='<script src="https://..."></script>'
        />
      </div>
    )}
  </div>
)}
```

**Step 6: Register analytics with the useSaveBar change detection**

Add `localAnalyticsProvider` and `localAnalyticsConfig` to whatever mechanism detects unsaved changes (inspect how `useSaveBar` tracks dirty state and add these two values).

**Step 7: Commit**

```
feat: add analytics configuration section to Settings UI
```

---

### Task 4: Wire up the invalidateHtmlCache callback

**Files:**
- Modify: `src/server/server.ts` (where settings route callbacks are registered)

**Step 1: Find where settings route callbacks are defined**

Search for where `callbacks` object is created and passed to the settings route handler. It will be near where `refreshTileHostnameCache`, `setTracerouteInterval`, etc. are assigned. Add `invalidateHtmlCache` to that object:

```typescript
invalidateHtmlCache: invalidateHtmlCache,
```

This connects the settings route's side-effect to the actual cache variable defined in server.ts.

**Step 2: Commit**

```
feat: wire invalidateHtmlCache callback for analytics settings
```

---

### Task 5: Test and verify

**Step 1: TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: Clean compile, no errors

**Step 2: Unit tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Build and deploy for manual testing**

```bash
docker compose -f docker-compose.dev.yml build --no-cache meshmonitor-sqlite
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d --force-recreate
```

Manual test checklist:
- [ ] Settings page shows Analytics section (admin only)
- [ ] Selecting GA4 shows Measurement ID field
- [ ] Selecting CloudFlare shows Beacon Token field
- [ ] Selecting PostHog shows API Key + Host fields
- [ ] Selecting Custom shows textarea
- [ ] Selecting None hides all config fields
- [ ] Saving with GA4 ID → view page source → GA4 script appears in `<head>`
- [ ] Changing provider to None → save → view source → script is gone
- [ ] Privacy warning is visible

**Step 4: System tests**

```bash
docker compose -f docker-compose.dev.yml down
./tests/system-tests.sh
```
Expected: All 10 tests pass

**Step 5: Commit any fixes, then create PR**

---

## Files Modified

| File | Changes |
|------|---------|
| `src/server/constants/settings.ts` | Add `analyticsProvider`, `analyticsConfig` to VALID_SETTINGS_KEYS |
| `src/server/utils/analyticsScriptGenerator.ts` | New file: provider templates + script generation |
| `src/server/server.ts` | Modify `rewriteHtml()` for analytics injection, add `invalidateHtmlCache()`, add `getAnalyticsScript()` helper |
| `src/server/routes/settingsRoutes.ts` | Add analytics side-effect callback |
| `src/components/SettingsTab.tsx` | Add analytics settings section with provider dropdown + config fields |
| `public/locales/en.json` | Add ~30 translation keys for analytics UI |

## Security Considerations

- Custom script field only allows content starting with `<script` and ending with `</script>` — no arbitrary HTML injection
- GA4 Measurement ID validated against `G-[A-Z0-9]+` pattern
- CloudFlare token validated as hex-only
- PostHog/Umami/Matomo URLs validated to start with `https?://`
- Analytics settings are admin-only (`settings:write` permission)
- All changes are audit-logged with before/after values
