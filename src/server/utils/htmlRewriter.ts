/**
 * HTML rewriter for the served SPA.
 *
 * Responsibilities (separate so each works independently of the other):
 *
 * 1. Analytics injection — insert the configured analytics provider's
 *    `<script>` tag into `<head>` so it runs on every page load. This must
 *    work in both root deployments (no BASE_URL) and sub-path deployments
 *    (e.g. BASE_URL=/meshmonitor), because the analytics tag is orthogonal
 *    to where the app is mounted.
 *
 * 2. BASE_URL rewriting — when the app is mounted under a sub-path, inject
 *    a `<base>` tag and rewrite all absolute asset paths (`/assets/…`,
 *    `/vite.svg`, `/favicon*`, manifest, service worker, etc.) to include
 *    the base prefix. This is a no-op in root deployments.
 *
 * These two concerns used to live in a single function that short-circuited
 * on `!baseUrl`, which meant that any root-deployment install silently
 * skipped analytics injection entirely — the configured GA4 tag would never
 * reach the browser. Keeping them in separate helpers makes that class of
 * bug impossible to reintroduce.
 */

/**
 * Inject an analytics `<script>` tag immediately after `<head>`. No-op if
 * `analyticsScript` is empty/undefined. Does not touch any other markup.
 */
export function injectAnalytics(htmlContent: string, analyticsScript?: string): string {
  if (!analyticsScript) return htmlContent;
  return htmlContent.replace(/<head>/, `<head>\n    ${analyticsScript}`);
}

/**
 * Apply BASE_URL rewriting: insert a `<base href="BASE_URL/">` tag and
 * rewrite absolute asset paths to be prefixed with BASE_URL. No-op if
 * `baseUrl` is empty.
 */
export function applyBaseUrl(htmlContent: string, baseUrl: string): string {
  if (!baseUrl) return htmlContent;

  const baseTag = `<base href="${baseUrl}/">`;
  let rewritten = htmlContent.replace(/<head>/, `<head>\n    ${baseTag}`);

  rewritten = rewritten
    .replace(/href="\/assets\//g, `href="${baseUrl}/assets/`)
    .replace(/src="\/assets\//g, `src="${baseUrl}/assets/`)
    .replace(/href="\/vite\.svg"/g, `href="${baseUrl}/vite.svg"`)
    .replace(/href="\/favicon\.ico"/g, `href="${baseUrl}/favicon.ico"`)
    .replace(/href="\/favicon-16x16\.png"/g, `href="${baseUrl}/favicon-16x16.png"`)
    .replace(/href="\/favicon-32x32\.png"/g, `href="${baseUrl}/favicon-32x32.png"`)
    .replace(/href="\/logo\.png"/g, `href="${baseUrl}/logo.png"`)
    // CORS detection script
    .replace(/src="\/cors-detection\.js"/g, `src="${baseUrl}/cors-detection.js"`)
    // PWA-related paths
    .replace(/href="\/manifest\.webmanifest"/g, `href="${baseUrl}/manifest.webmanifest"`)
    .replace(/src="\/registerSW\.js"/g, `src="${baseUrl}/registerSW.js"`);

  return rewritten;
}

/**
 * Full HTML rewriter used by the SPA request handlers. Injects analytics
 * first (so the tag lands right after `<head>`, ahead of the base tag in
 * sub-path deployments), then applies BASE_URL rewriting.
 *
 * Either or both of `baseUrl` and `analyticsScript` may be empty — each
 * branch is independent.
 */
export function rewriteHtml(
  htmlContent: string,
  baseUrl: string,
  analyticsScript?: string
): string {
  const withAnalytics = injectAnalytics(htmlContent, analyticsScript);
  return applyBaseUrl(withAnalytics, baseUrl);
}
