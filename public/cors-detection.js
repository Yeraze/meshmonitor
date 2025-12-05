// CORS error detection - redirect to error page ONLY if actual CORS errors occur
let corsErrorCount = 0;
let appLoaded = false;

// Redirect to CORS error page
function redirectToCorsError() {
  if (appLoaded) return; // Don't redirect if app already loaded
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
      console.log('[CORS Detection] CORS fetch error on', url, 'count:', corsErrorCount);
      if (corsErrorCount >= 2) {
        redirectToCorsError();
      }
    } else if (error.name === 'TypeError' && errorMessage.includes('failed to fetch')) {
      // This could be CORS or network - check if it's an API call
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/api/') || urlStr.includes('/auth/')) {
        corsErrorCount++;
        console.log('[CORS Detection] Likely CORS error (failed to fetch API)', url, 'count:', corsErrorCount);
        if (corsErrorCount >= 2) {
          redirectToCorsError();
        }
      }
    }
    throw error;
  });
};

// Mark as loaded if React mounts anything - this prevents any redirect
const observer = new MutationObserver(() => {
  if (document.getElementById('root').children.length > 0) {
    appLoaded = true;
    console.log('[CORS Detection] React app mounted - CORS detection disabled');
    observer.disconnect();
  }
});
observer.observe(document.getElementById('root'), { childList: true });
