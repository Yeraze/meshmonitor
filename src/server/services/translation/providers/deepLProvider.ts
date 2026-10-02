import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider, ProviderConfig, TranslationProviderResult } from './types.js';
import { buildServiceEndpoint } from './libreTranslateProvider.js';

export class DeepLProvider implements ITranslationProvider {
  readonly id: TranslationProvider = 'deepl';

  /**
   * Maps canonical ISO 639-1 language code to DeepL's required target_lang format.
   * DeepL requires regional variants for certain target languages (EN, PT) and NB for Norwegian.
   */
  private mapTargetLanguage(lang: string): string {
    const upper = (lang || '').trim().toUpperCase();
    if (upper === 'EN') return 'EN-US';
    if (upper === 'PT') return 'PT-PT';
    if (upper === 'NO') return 'NB';
    return upper;
  }

  /**
   * Maps source language code to DeepL's accepted source_lang format.
   */
  private mapSourceLanguage(lang: string): string {
    const upper = (lang || '').trim().toUpperCase();
    if (upper === 'NO') return 'NB';
    return upper;
  }

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult> {
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error('DeepL API key is required');
    }

    const key = config.apiKey.trim();
    const defaultEndpoint = key.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
    const endpoint = buildServiceEndpoint(config.deeplUrl || '', defaultEndpoint, '/translate');

    const body: Record<string, unknown> = {
      text: [text],
      target_lang: this.mapTargetLanguage(targetLang),
    };

    if (sourceLang && sourceLang !== 'auto') {
      body.source_lang = this.mapSourceLanguage(sourceLang);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`DeepL API error (${response.status}): ${errText || response.statusText}`);
    }

    const data = (await response.json()) as {
      translations?: Array<{ text: string; detected_source_language?: string }>;
    };

    const first = data.translations?.[0];
    if (!first) {
      throw new Error('DeepL returned an empty translations array');
    }

    return {
      translatedText: first.text,
      detectedSourceLanguage: first.detected_source_language?.toLowerCase(),
    };
  }
}
