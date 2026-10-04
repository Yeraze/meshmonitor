import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider, ProviderConfig, TranslationProviderResult } from './types.js';
import { buildServiceEndpoint } from './translateUtils.js';

export class OpenAIProvider implements ITranslationProvider {
  readonly id: TranslationProvider = 'openai';

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult> {
    const endpoint = buildServiceEndpoint(
      config.openAiBaseUrl || '',
      'http://host.docker.internal:11434/v1/chat/completions',
      '/v1/chat/completions',
      '/chat/completions'
    );
    const model = config.model || 'gpt-4o-mini';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey && config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }

    const systemPrompt = `You are an expert translator for LoRa mesh and radio chat messages.
Translate the user's message accurately${sourceLang && sourceLang !== 'auto' ? ` from "${sourceLang}"` : ''} into the target language: "${targetLang}".
Guidelines:
1. Preserve callsigns, node tags (e.g. !1234abcd), numbers, radio abbreviations, and emoji.
2. Keep the output as concise as possible to respect LoRa packet constraints.
3. Return ONLY the translated text with NO quotation marks, markdown wrappers, introductory notes, or commentary.`;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`OpenAI-compatible endpoint error (${response.status}): ${errText || response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI endpoint returned an invalid response structure');
    }

    return {
      translatedText: content.trim(),
    };
  }
}
