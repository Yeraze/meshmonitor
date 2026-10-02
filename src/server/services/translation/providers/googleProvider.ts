import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider, ProviderConfig, TranslationProviderResult } from './types.js';

export class GoogleProvider implements ITranslationProvider {
  readonly id: TranslationProvider = 'google';

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult> {
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error('Google Cloud Translation API key is required');
    }

    const key = encodeURIComponent(config.apiKey.trim());
    const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${key}`;

    const body: Record<string, unknown> = {
      q: text,
      target: targetLang,
      format: 'text',
    };

    if (sourceLang && sourceLang !== 'auto') {
      body.source = sourceLang;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Google Translation API error (${response.status}): ${errText || response.statusText}`);
    }

    const data = (await response.json()) as {
      data?: {
        translations?: Array<{ translatedText: string; detectedSourceLanguage?: string }>;
      };
    };

    const first = data.data?.translations?.[0];
    if (!first) {
      throw new Error('Google Translation API returned an empty response');
    }

    return {
      translatedText: first.translatedText,
      detectedSourceLanguage: first.detectedSourceLanguage?.toLowerCase(),
    };
  }
}
