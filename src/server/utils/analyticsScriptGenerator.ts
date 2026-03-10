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
      if (!script.startsWith('<script') || !script.endsWith('</script>')) return '';
      return script;
    }
    default:
      return '';
  }
}
