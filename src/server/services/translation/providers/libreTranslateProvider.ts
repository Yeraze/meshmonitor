import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider, ProviderConfig, TranslationProviderResult } from './types.js';
import { buildServiceEndpoint } from './translateUtils.js';
import { assertSafeUrl } from '../../../utils/ssrfGuard.js';
import { logger } from '../../../../utils/logger.js';

/**
 * SSRF guard options for translation backends (SSRF-02, issue #6061). Non-strict
 * so a LAN / docker-network backend (the default is `http://libretranslate:5000`)
 * still works, and allowLoopback so a backend on the same host works — but cloud
 * metadata, link-local, multicast and the IPv4-mapped IPv6 bypass are blocked.
 */
const TRANSLATION_SSRF_OPTS = { strict: false, allowLoopback: true } as const;

export class LibreTranslateProvider implements ITranslationProvider {
  readonly id: TranslationProvider = 'libretranslate';

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult> {
    const endpoint = buildServiceEndpoint(config.url || '', 'http://libretranslate:5000/translate', '/translate');

    const body: Record<string, unknown> = {
      q: text,
      source: !sourceLang || sourceLang === 'auto' ? 'auto' : sourceLang.toLowerCase(),
      target: targetLang.toLowerCase(),
      format: 'text',
    };

    if (config.apiKey && config.apiKey.trim()) {
      body.api_key = config.apiKey.trim();
    }

    // Validate the (operator-configurable) endpoint against the SSRF guard
    // before connecting (SSRF-02).
    await assertSafeUrl(endpoint, TRANSLATION_SSRF_OPTS);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Do NOT surface the upstream body to the caller — on an internal target
      // that body is an SSRF exfiltration channel (SSRF-02). Log it server-side
      // and throw a status-only message.
      const errText = await response.text().catch(() => '');
      if (errText) logger.debug(`LibreTranslate error body (${response.status}): ${errText}`);
      throw new Error(`LibreTranslate error (${response.status}): ${response.statusText || 'request failed'}`);
    }

    const data = (await response.json()) as {
      translatedText?: string;
      detectedLanguage?: { confidence?: number; language?: string };
    };

    if (!data.translatedText && data.translatedText !== '') {
      throw new Error('LibreTranslate returned empty or invalid response');
    }

    return {
      translatedText: data.translatedText,
      detectedSourceLanguage: data.detectedLanguage?.language?.toLowerCase(),
    };
  }
}
