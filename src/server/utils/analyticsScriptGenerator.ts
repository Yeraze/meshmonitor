export type AnalyticsProvider = 'none' | 'ga4' | 'cloudflare' | 'posthog' | 'plausible' | 'umami' | 'matomo' | 'custom';

interface AnalyticsConfig {
  measurementId?: string;
  beaconToken?: string;
  apiKey?: string;
  apiHost?: string;
  domain?: string;
  websiteId?: string;
  scriptUrl?: string;
  siteUrl?: string;
  siteId?: string;
  script?: string;
  cspDomains?: string;
}

/**
 * Encode a value for safe interpolation inside a double-quoted HTML attribute.
 * Neutralises the attribute-breakout vector (a literal `"` closing the
 * attribute and injecting an event handler, e.g. XSS-02 / #6063) as well as
 * `<`, `>` and `&`. Single quotes are encoded too, so the result is also safe
 * inside a single-quoted attribute.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Encode a value for safe interpolation inside a quoted JavaScript string
 * literal in an inline `<script>` block. Escaping `<` and `>` to `\x3C`/`\x3E`
 * also defeats the HTML-parser-confusion vector where an embedded `</script>`
 * prematurely closes the script element and starts a new, attacker-controlled
 * one (XSS-01 / #6062). The result is valid inside both single- and
 * double-quoted JS strings.
 */
function escapeJsString(value: string): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, '\\x3C')
    .replace(/>/g, '\\x3E')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .split(LS).join('\u2028')
    .split(PS).join('\u2029');
}

/**
 * Generate analytics script tags for injection into HTML <head>.
 * Returns empty string if provider is 'none' or config is invalid.
 *
 * SECURITY: admin-supplied values interpolated into the emitted markup are
 * either strictly allowlisted (e.g. GA4 / Cloudflare ids) or context-encoded
 * for their injection site (HTML attribute vs. JS string literal). Never
 * interpolate a raw config value into the output without one of those — the
 * result is served verbatim in the HTML <head> to every visitor.
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
      // PostHog project API keys are opaque tokens (e.g. `phc_…`); a real key
      // never contains markup. Strict allowlist rejects a `</script>` / quote
      // breakout payload outright (XSS-01 / #6062).
      if (!/^[A-Za-z0-9_-]+$/.test(key)) return '';
      // The host is a URL and can legitimately carry a path, so encode it for
      // the JS-string context rather than allowlisting.
      const safeHost = escapeJsString(host);
      return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${key}',{api_host:'${safeHost}'});</script>`;
    }
    case 'plausible': {
      const domain = config.domain?.trim();
      if (!domain) return '';
      // Encode for the `data-domain` attribute context: a raw `"` would close
      // the attribute and let an `onerror=` handler be injected (XSS-02 / #6063).
      return `<script defer data-domain="${escapeHtmlAttribute(domain)}" src="https://plausible.io/js/script.js"></script>`;
    }
    case 'umami': {
      const id = config.websiteId?.trim();
      const url = config.scriptUrl?.trim();
      if (!id || !url) return '';
      if (!/^https?:\/\//.test(url)) return '';
      // Same attribute-breakout class as plausible: encode both values for the
      // HTML-attribute context before interpolating.
      return `<script async src="${escapeHtmlAttribute(url)}" data-website-id="${escapeHtmlAttribute(id)}"></script>`;
    }
    case 'matomo': {
      const siteUrl = config.siteUrl?.trim()?.replace(/\/+$/, '');
      const siteId = config.siteId?.trim();
      if (!siteUrl || !siteId) return '';
      if (!/^https?:\/\//.test(siteUrl)) return '';
      // Both values land inside quoted JS string literals in an inline script;
      // encode for that context so neither can break out or inject a
      // `</script>` (same class as XSS-01).
      const safeSiteUrl = escapeJsString(siteUrl);
      const safeSiteId = escapeJsString(siteId);
      return `<script>var _paq=window._paq=window._paq||[];_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u="${safeSiteUrl}/";_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId','${safeSiteId}']);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.async=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();</script>`;
    }
    case 'custom': {
      const script = config.script?.trim();
      if (!script) return '';
      if (!script.startsWith('<script') || !script.endsWith('</script>')) return '';
      return script;
    }
    default:
      return '';
  }
}

/**
 * Return CSP domains needed for a given analytics provider.
 * Returns { scriptSrc: [...], connectSrc: [...] } with the external
 * origins the browser must be allowed to reach.
 */
export function getAnalyticsCspDomains(
  provider: AnalyticsProvider,
  config: AnalyticsConfig
): { scriptSrc: string[]; connectSrc: string[] } {
  const empty = { scriptSrc: [], connectSrc: [] };

  switch (provider) {
    case 'ga4':
      return {
        scriptSrc: ['https://www.googletagmanager.com', 'https://www.google-analytics.com'],
        connectSrc: ['https://www.google-analytics.com', 'https://analytics.google.com', 'https://www.googletagmanager.com'],
      };
    case 'cloudflare':
      return {
        scriptSrc: ['https://static.cloudflareinsights.com'],
        connectSrc: ['https://cloudflareinsights.com'],
      };
    case 'posthog': {
      const host = config.apiHost?.trim();
      if (!host || !/^https?:\/\//.test(host)) return empty;
      const origin = new URL(host).origin;
      return { scriptSrc: [origin], connectSrc: [origin] };
    }
    case 'plausible':
      return {
        scriptSrc: ['https://plausible.io'],
        connectSrc: ['https://plausible.io'],
      };
    case 'umami': {
      const url = config.scriptUrl?.trim();
      if (!url || !/^https?:\/\//.test(url)) return empty;
      const origin = new URL(url).origin;
      return { scriptSrc: [origin], connectSrc: [origin] };
    }
    case 'matomo': {
      const siteUrl = config.siteUrl?.trim();
      if (!siteUrl || !/^https?:\/\//.test(siteUrl)) return empty;
      const origin = new URL(siteUrl).origin;
      return { scriptSrc: [origin], connectSrc: [origin] };
    }
    case 'custom': {
      const raw = config.cspDomains?.trim();
      if (!raw) return empty;
      const domains = raw.split(/[\s,]+/).filter((d) => /^https?:\/\//.test(d));
      const origins = domains.map((d) => {
        try { return new URL(d).origin; } catch { return null; }
      }).filter(Boolean) as string[];
      return { scriptSrc: origins, connectSrc: origins };
    }
    default:
      return empty;
  }
}
