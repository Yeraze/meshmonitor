import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider, ProviderConfig, TranslationProviderResult } from './types.js';
import { buildServiceEndpoint } from './translateUtils.js';

export class LibreTranslateProvider implements ITranslationProvider {
  readonly id: TranslationProvider = 'libretranslate';

  resolveEndpoint(url?: string): string {
    return buildServiceEndpoint(url || '', 'http://libretranslate:5000/translate', '/translate');
  }

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult> {
    const endpoint = (config.url || '').trim();
    if (!endpoint) {
      throw new Error('LibreTranslate URL is required');
    }

    const body: Record<string, unknown> = {
      q: text,
      source: !sourceLang || sourceLang === 'auto' ? 'auto' : sourceLang.toLowerCase(),
      target: targetLang.toLowerCase(),
      format: 'text',
    };

    if (config.apiKey && config.apiKey.trim()) {
      body.api_key = config.apiKey.trim();
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LibreTranslate error (${response.status}): ${errText || response.statusText}`);
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
