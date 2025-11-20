// CORS error detection - redirect to error page if CORS blocks the app
let corsErrorCount = 0;
let appLoaded = false;
let authCheckFailed = false;

// Monitor console errors for CORS issues
const originalConsoleError = console.error;
console.error = function(...args) {
  const message = args.join(' ');
  if (message.includes('CORS') || message.includes('500') || message.includes('NetworkError')) {
    corsErrorCount++;
    console.log('[CORS Detection] Error detected, count:', corsErrorCount);
  }
  return originalConsoleError.apply(console, args);
};

// Intercept fetch to detect CORS/network errors
const originalFetch = window.fetch;
window.fetch = function(...args) {
  const url = args[0];
  return originalFetch.apply(this, args).then(response => {
    // Check for 500 errors which often indicate CORS issues
    if (response.status === 500) {
      corsErrorCount++;
      console.log('[CORS Detection] 500 error on', url, 'count:', corsErrorCount);
    }
    // Check if /auth/status fails - critical endpoint
    if (url.includes('/auth/status') && !response.ok) {
      authCheckFailed = true;
      console.log('[CORS Detection] Auth check failed');
    }
    return response;
  }).catch(error => {
    corsErrorCount++;
    console.log('[CORS Detection] Fetch error on', url, 'count:', corsErrorCount);
    throw error;
  });
};

// Set a timeout to check if the app loaded successfully
setTimeout(() => {
  // If we detected ANY CORS/network errors, auth check failed, or app didn't load
  if (corsErrorCount >= 1 || authCheckFailed || (!appLoaded && document.getElementById('root').children.length === 0)) {
    console.log('[CORS Detection] Redirecting to error page. Errors:', corsErrorCount, 'Auth failed:', authCheckFailed, 'App loaded:', appLoaded);
    // Redirect to error page - use BASE_URL from <base> tag if available
    const baseTag = document.querySelector('base');
    const baseUrl = baseTag ? baseTag.href.replace(/\/$/, '') : window.location.origin;
    window.location.href = baseUrl + '/cors-error.html';
  }
}, 5000); // Wait 5 seconds for app to load and detect CORS issues

// Mark as loaded if React mounts anything
const observer = new MutationObserver(() => {
  if (document.getElementById('root').children.length > 0) {
    appLoaded = true;
    observer.disconnect();
  }
});
observer.observe(document.getElementById('root'), { childList: true });
