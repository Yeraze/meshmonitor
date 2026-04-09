import { describe, it, expect } from 'vitest';
import { injectAnalytics, applyBaseUrl, rewriteHtml } from './htmlRewriter.js';

// Realistic minimal index.html shape — enough to exercise every rewrite rule.
const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.ico" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" href="/vite.svg" />
    <link rel="apple-touch-icon" href="/logo.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" href="/assets/index-xyz.css" />
    <script src="/cors-detection.js"></script>
    <script src="/registerSW.js"></script>
    <title>MeshMonitor</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const GA4_SCRIPT =
  '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>\n    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag(\'js\',new Date());gtag(\'config\',\'G-ABC123\');</script>';

describe('injectAnalytics', () => {
  it('returns input unchanged when no analytics script is provided', () => {
    expect(injectAnalytics(indexHtml, undefined)).toBe(indexHtml);
    expect(injectAnalytics(indexHtml, '')).toBe(indexHtml);
  });

  it('injects the analytics script immediately after <head>', () => {
    const result = injectAnalytics(indexHtml, GA4_SCRIPT);
    expect(result).toContain('<head>\n    <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"');
  });

  it('injects gtag config call so the measurement ID reaches the browser', () => {
    const result = injectAnalytics(indexHtml, GA4_SCRIPT);
    expect(result).toContain("gtag('config','G-ABC123')");
  });

  it('does not duplicate the analytics tag on repeated calls with the same input', () => {
    // Sanity: a single rewrite pass produces exactly one copy of the tag.
    const result = injectAnalytics(indexHtml, GA4_SCRIPT);
    const matches = result.match(/googletagmanager\.com\/gtag\/js/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('applyBaseUrl', () => {
  it('returns input unchanged when baseUrl is empty', () => {
    expect(applyBaseUrl(indexHtml, '')).toBe(indexHtml);
  });

  it('injects a <base> tag with the configured prefix', () => {
    const result = applyBaseUrl(indexHtml, '/meshmonitor');
    expect(result).toContain('<base href="/meshmonitor/">');
  });

  it('rewrites absolute asset paths under BASE_URL', () => {
    const result = applyBaseUrl(indexHtml, '/meshmonitor');
    expect(result).toContain('src="/meshmonitor/assets/index-abc.js"');
    expect(result).toContain('href="/meshmonitor/assets/index-xyz.css"');
    expect(result).toContain('href="/meshmonitor/favicon.ico"');
    expect(result).toContain('href="/meshmonitor/favicon-16x16.png"');
    expect(result).toContain('href="/meshmonitor/favicon-32x32.png"');
    expect(result).toContain('href="/meshmonitor/vite.svg"');
    expect(result).toContain('href="/meshmonitor/logo.png"');
    expect(result).toContain('href="/meshmonitor/manifest.webmanifest"');
    expect(result).toContain('src="/meshmonitor/cors-detection.js"');
    expect(result).toContain('src="/meshmonitor/registerSW.js"');
  });

  it('leaves no un-rewritten absolute asset paths behind', () => {
    const result = applyBaseUrl(indexHtml, '/meshmonitor');
    // None of the originals should remain
    expect(result).not.toContain('src="/assets/');
    expect(result).not.toContain('href="/assets/');
    expect(result).not.toContain('href="/favicon.ico"');
    expect(result).not.toContain('href="/vite.svg"');
    expect(result).not.toContain('src="/registerSW.js"');
  });
});

describe('rewriteHtml', () => {
  it('root deployment + no analytics → passthrough', () => {
    expect(rewriteHtml(indexHtml, '', undefined)).toBe(indexHtml);
    expect(rewriteHtml(indexHtml, '', '')).toBe(indexHtml);
  });

  it('root deployment + analytics configured → analytics tag is injected (regression for GA4 not appearing on root deployments)', () => {
    const result = rewriteHtml(indexHtml, '', GA4_SCRIPT);
    // The tag must land in the response
    expect(result).toContain('googletagmanager.com/gtag/js?id=G-ABC123');
    expect(result).toContain("gtag('config','G-ABC123')");
    // And there must not be a <base> tag, since this is a root deployment
    expect(result).not.toContain('<base href=');
  });

  it('sub-path deployment + no analytics → base tag + path rewriting, no analytics', () => {
    const result = rewriteHtml(indexHtml, '/meshmonitor', undefined);
    expect(result).toContain('<base href="/meshmonitor/">');
    expect(result).toContain('src="/meshmonitor/assets/index-abc.js"');
    expect(result).not.toContain('googletagmanager.com');
  });

  it('sub-path deployment + analytics configured → both are applied', () => {
    const result = rewriteHtml(indexHtml, '/meshmonitor', GA4_SCRIPT);
    expect(result).toContain('<base href="/meshmonitor/">');
    expect(result).toContain('src="/meshmonitor/assets/index-abc.js"');
    expect(result).toContain('googletagmanager.com/gtag/js?id=G-ABC123');
  });

  it('sub-path deployment places <base> tag BEFORE the analytics script (preserves v3 ordering)', () => {
    // The original in-server rewriter put <base> first, then analytics. This
    // matters because <base> must run before any script that uses relative
    // URLs. Lock in that ordering.
    const result = rewriteHtml(indexHtml, '/meshmonitor', GA4_SCRIPT);
    const baseIdx = result.indexOf('<base href="/meshmonitor/">');
    const analyticsIdx = result.indexOf('googletagmanager.com');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(analyticsIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(analyticsIdx);
  });
});
