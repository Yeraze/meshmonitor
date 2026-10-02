import { describe, it, expect } from 'vitest';
import { buildServiceEndpoint } from './translateUtils.js';

describe('translateUtils', () => {
  describe('buildServiceEndpoint', () => {
    it('should return default fallback when url is empty or whitespace', () => {
      expect(buildServiceEndpoint('', 'http://default/v1', '/v1')).toBe('http://default/v1');
      expect(buildServiceEndpoint('   ', 'http://default/v1', '/v1')).toBe('http://default/v1');
    });

    it('should prepend defaultEndpoint protocol if no protocol is provided on bare origin', () => {
      // http defaultEndpoint -> prepends http://
      expect(buildServiceEndpoint('localhost:5000', 'http://libretranslate:5000/translate', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('localhost:5000/', 'http://libretranslate:5000/translate', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('libretranslate.local', 'http://libretranslate:5000/translate', '/translate')).toBe('http://libretranslate.local/translate');

      // https defaultEndpoint -> prepends https://
      expect(buildServiceEndpoint('api.deepl.com', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://api.deepl.com/translate');
      expect(buildServiceEndpoint('api.deepl.com/', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://api.deepl.com/translate');
    });

    it('should prepend defaultEndpoint protocol if no protocol is provided on URL with path', () => {
      // http defaultEndpoint -> prepends http://
      expect(buildServiceEndpoint('localhost:11434/v1/chat/completions', 'http://host.docker.internal:11434/v1/chat/completions', '/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');

      // https defaultEndpoint -> prepends https://
      expect(buildServiceEndpoint('my-proxy.com/api/translate', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://my-proxy.com/api/translate');
      expect(buildServiceEndpoint('my-proxy.com/api/translate/', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://my-proxy.com/api/translate');
    });

    it('should preserve explicit http:// and https:// protocols', () => {
      expect(buildServiceEndpoint('http://localhost:5000', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('https://localhost:5000', 'default', '/translate')).toBe('https://localhost:5000/translate');
    });

    it('should append default path on bare origins with or without trailing slash', () => {
      expect(buildServiceEndpoint('http://localhost:5000', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('http://localhost:5000/', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('https://api.deepl.com', 'default', '/translate')).toBe('https://api.deepl.com/translate');
      expect(buildServiceEndpoint('https://api.deepl.com/', 'default', '/translate')).toBe('https://api.deepl.com/translate');
    });

    it('should handle default path without leading slash', () => {
      expect(buildServiceEndpoint('http://localhost:5000', 'default', 'translate')).toBe('http://localhost:5000/translate');
    });

    it('should use URL with a path beyond origin verbatim', () => {
      expect(buildServiceEndpoint('http://localhost:5000/translate', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('http://proxy.internal/my-service/v1', 'default', '/translate')).toBe('http://proxy.internal/my-service/v1');
      expect(buildServiceEndpoint('https://api.deepl.com/v2/translate', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('http://host.docker.internal:11434/v1/chat/completions', 'default', '/chat/completions')).toBe('http://host.docker.internal:11434/v1/chat/completions');
    });

    it('should strip trailing slash from path beyond origin', () => {
      expect(buildServiceEndpoint('http://localhost:5000/translate/', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('https://proxy.internal/custom/v1/', 'default', '/chat/completions')).toBe('https://proxy.internal/custom/v1');
    });

    it('should preserve query parameters and hashes if present', () => {
      expect(buildServiceEndpoint('https://proxy.internal/translate?apiKey=123', 'default', '/translate')).toBe('https://proxy.internal/translate?apiKey=123');
    });
  });
});
