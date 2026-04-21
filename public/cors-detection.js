// CORS error detection - redirect to error page ONLY if actual CORS errors occur
let corsErrorCount = 0;
let appLoaded = false;

// Strip ASCII C0/C1 control chars + DEL before logging untrusted input to
// prevent log-injection (CWE-117). Built via RegExp() so this source file
// never contains literal control characters.
const CORS_CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F]+', 'g');
function sanitizeForLog(value) {
  if (typeof value === 'string') return value.replace(CORS_CONTROL_CHAR_RE, ' ');
  try {
    return String(value).replace(CORS_CONTROL_CHAR_RE, ' ');
  } catch (_e) {
    return '[unprintable]';
  }
}

// Detect PWA standalone mode (iOS and standard)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

// Redirect to CORS error page
function redirectToCorsError() {
  if (appLoaded) return; // Don't redirect if app already loaded
  if (isStandalone) return; // Don't redirect in PWA mode - fetch failures are network, not CORS
  console.log('[CORS Detection] Redirecting to error page. CORS errors:', corsErrorCount);
  const baseTag = document.querySelector('base');
  const baseUrl = baseTag ? baseTag.href.replace(/\/$/, '') : window.location.origin;
  window.location.href = baseUrl + '/cors-error.html';
}

// Monitor console errors for CORS issues
const originalConsoleError = console.error;
console.error = function(...args) {
  const message = args.join(' ');
  // Only count actual CORS errors
  if (message.includes('CORS') || message.includes('Access-Control-Allow-Origin') ||
      message.includes('blocked by CORS') || message.includes('Cross-Origin')) {
    corsErrorCount++;
    console.log('[CORS Detection] CORS error detected, count:', corsErrorCount);
    // Redirect immediately on CORS error - no need to wait
    if (corsErrorCount >= 2) {
      redirectToCorsError();
    }
  }
  return originalConsoleError.apply(console, args);
};

// Intercept fetch to detect CORS errors
const originalFetch = window.fetch;
window.fetch = function(...args) {
  const url = args[0];
  return originalFetch.apply(this, args).catch(error => {
    // Check if this is a CORS error
    const errorMessage = (error.message || '').toLowerCase();
    const errorName = (error.name || '').toLowerCase();

    // TypeError with "Failed to fetch" on API calls is typically CORS
    // But we need to be careful not to count slow network as CORS
    if (errorMessage.includes('cors') || errorMessage.includes('access-control') ||
        errorMessage.includes('cross-origin') || errorName.includes('cors')) {
      corsErrorCount++;
      console.log('[CORS Detection] CORS fetch error on', sanitizeForLog(url), 'count:', corsErrorCount);
      if (corsErrorCount >= 2) {
        redirectToCorsError();
      }
    } else if (error.name === 'TypeError' && errorMessage.includes('failed to fetch')) {
      // This could be CORS or network - check if it's an API call
      // In PWA standalone mode, "Failed to fetch" is almost always a network timing issue
      // during cold launch, not a CORS error - skip counting in that case
      if (!isStandalone) {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/api/') || urlStr.includes('/auth/')) {
          corsErrorCount++;
          console.log('[CORS Detection] Likely CORS error (failed to fetch API)', sanitizeForLog(url), 'count:', corsErrorCount);
          if (corsErrorCount >= 2) {
            redirectToCorsError();
          }
        }
      }
    }
    throw error;
  });
};

// Mark as loaded if React mounts anything - this prevents any redirect
const rootElement = document.getElementById('root');
if (rootElement) {
  const observer = new MutationObserver(() => {
    if (rootElement.children.length > 0) {
      appLoaded = true;
      console.log('[CORS Detection] React app mounted - CORS detection disabled');
      observer.disconnect();
    }
  });
  observer.observe(rootElement, { childList: true });
}
