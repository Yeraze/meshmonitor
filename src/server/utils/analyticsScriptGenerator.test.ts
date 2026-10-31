/**
 * Security regression tests for the analytics <script> generator.
 *
 * The generator interpolates admin-supplied values (PostHog key/host, Plausible
 * domain, Umami id/url, Matomo url/id) into markup that is served verbatim in
 * the HTML <head> to every visitor. Before the #6062 / #6063 fixes those values
 * were injected with no context-correct encoding, so a `</script>` or an
 * attribute-breakout payload escaped into executable script. These tests assert
 * the payloads can no longer break out, while valid configs still render.
 */
import { describe, it, expect } from 'vitest';
import { generateAnalyticsScript } from './analyticsScriptGenerator.js';

describe('generateAnalyticsScript — XSS hardening', () => {
  describe('posthog (XSS-01 / #6062)', () => {
    it('renders a valid key + host', () => {
      const out = generateAnalyticsScript('posthog', {
        apiKey: 'phc_abcDEF123',
        apiHost: 'https://eu.posthog.com',
      });
      expect(out).toContain("posthog.init('phc_abcDEF123'");
      expect(out).toContain("api_host:'https://eu.posthog.com'");
    });

    it('rejects a key carrying a </script> breakout payload', () => {
      const out = generateAnalyticsScript('posthog', {
        apiKey: '</script><script>alert(1)</script><x',
        apiHost: 'https://eu.posthog.com',
      });
      // Strict allowlist rejects the whole config → no script emitted at all.
      expect(out).toBe('');
    });

    it('rejects a key with any non-token character', () => {
      for (const key of ["abc'def", 'abc"def', 'abc<def', 'abc def', 'abc&def']) {
        expect(generateAnalyticsScript('posthog', { apiKey: key, apiHost: 'https://x.com' })).toBe('');
      }
    });

    it('neutralises a host that tries to break out of the JS string', () => {
      const out = generateAnalyticsScript('posthog', {
        apiKey: 'phc_valid',
        apiHost: "https://x'});document.title='pwned';//",
      });
      expect(out).not.toBe('');
      // The raw single-quote-breakout sequence must not survive verbatim.
      expect(out).not.toContain("'});document.title='pwned'");
      // No second, unescaped </script> appears.
      expect(out.match(/<\/script>/gi)?.length ?? 0).toBe(1);
    });

    it('escapes a host containing </script>', () => {
      const out = generateAnalyticsScript('posthog', {
        apiKey: 'phc_valid',
        apiHost: 'https://x</script><script>alert(1)</script>',
      });
      expect(out).not.toBe('');
      expect(out).not.toContain('<script>alert(1)</script>');
      expect(out.match(/<\/script>/gi)?.length ?? 0).toBe(1);
    });
  });

  describe('plausible (XSS-02 / #6063)', () => {
    it('renders a valid domain', () => {
      const out = generateAnalyticsScript('plausible', { domain: 'example.com' });
      expect(out).toContain('data-domain="example.com"');
    });

    it('neutralises an attribute-breakout + onerror payload', () => {
      const out = generateAnalyticsScript('plausible', {
        domain: 'x" onerror="alert(1)',
      });
      expect(out).not.toBe('');
      // The closing quote + onerror handler must be entity-encoded, not literal.
      expect(out).not.toContain('onerror="alert(1)"');
      expect(out).not.toContain('"x" onerror');
      expect(out).toContain('&quot;');
    });
  });

  describe('umami (same attribute-breakout class)', () => {
    it('neutralises a breakout in the script URL and website id', () => {
      const out = generateAnalyticsScript('umami', {
        scriptUrl: 'https://x" onload="alert(1)',
        websiteId: 'y" onload="alert(2)',
      });
      expect(out).not.toBe('');
      expect(out).not.toContain('onload="alert(1)"');
      expect(out).not.toContain('onload="alert(2)"');
    });
  });

  describe('matomo (same JS-string class)', () => {
    it('neutralises a breakout in the site id', () => {
      const out = generateAnalyticsScript('matomo', {
        siteUrl: 'https://matomo.example.com',
        siteId: "1']);alert(1);//",
      });
      expect(out).not.toBe('');
      expect(out).not.toContain("1']);alert(1)");
      expect(out.match(/<\/script>/gi)?.length ?? 0).toBe(1);
    });
  });

  describe('custom (XSS-03 / #6064 — intended admin feature)', () => {
    // The custom provider is deliberately arbitrary script injection, gated to
    // admins at the settings write-path (analyticsConfig is secret +
    // ADMIN_ONLY_SETTINGS_KEYS). This test only pins the existing shape check.
    it('still passes a well-formed script through unchanged', () => {
      const script = '<script>console.log("hi")</script>';
      expect(generateAnalyticsScript('custom', { script })).toBe(script);
    });

    it('returns empty for a non-script value', () => {
      expect(generateAnalyticsScript('custom', { script: 'not a script' })).toBe('');
    });
  });

  describe('CSP nonce stamping (MISC-09 / #6085)', () => {
    it('stamps a nonce on the inline GA4 config script', () => {
      const out = generateAnalyticsScript('ga4', { measurementId: 'G-ABC123' }, 'N0nCe==');
      // Both the external loader and the inline config carry the nonce.
      const count = (out.match(/<script nonce="N0nCe=="/g) || []).length;
      expect(count).toBe(2);
      // No bare <script that lacks the nonce attribute.
      expect(out).not.toMatch(/<script(?! nonce=)/);
    });

    it('stamps a nonce on the inline posthog bootstrap script', () => {
      const out = generateAnalyticsScript('posthog', { apiKey: 'phc_abc', apiHost: 'https://ph.example.com' }, 'XYZ');
      expect(out.startsWith('<script nonce="XYZ">')).toBe(true);
      // The string "script" occurrences inside the inline JS must NOT be stamped.
      expect(out).toContain('createElement("script")');
      expect(out).not.toContain('<script nonce="XYZ">createElement');
    });

    it('stamps a nonce on a custom admin-provided inline script', () => {
      const script = '<script>console.log("hi")</script>';
      expect(generateAnalyticsScript('custom', { script }, 'abc')).toBe('<script nonce="abc">console.log("hi")</script>');
    });

    it('is a no-op when no nonce is supplied (output unchanged)', () => {
      const withNonce = generateAnalyticsScript('ga4', { measurementId: 'G-ABC123' });
      expect(withNonce).not.toContain('nonce=');
    });
  });
});
