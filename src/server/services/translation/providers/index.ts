import type { TranslationProvider } from '../../../../types/translation.js';
import type { ITranslationProvider } from './types.js';
import { LibreTranslateProvider } from './libreTranslateProvider.js';
import { DeepLProvider } from './deepLProvider.js';
import { OpenAIProvider } from './openAiProvider.js';
import { GoogleProvider } from './googleProvider.js';

export * from './types.js';
export * from './libreTranslateProvider.js';
export * from './deepLProvider.js';
export * from './openAiProvider.js';
export * from './googleProvider.js';

const providerInstances: Record<TranslationProvider, ITranslationProvider> = {
  libretranslate: new LibreTranslateProvider(),
  deepl: new DeepLProvider(),
  openai: new OpenAIProvider(),
  google: new GoogleProvider(),
};

/**
 * Returns the translation provider instance corresponding to the given provider identifier.
 *
 * @param provider The provider identifier ('libretranslate' | 'deepl' | 'openai' | 'google')
 * @returns An instance implementing ITranslationProvider
 * @throws Error if the provider identifier is unsupported
 */
export function getTranslationProvider(provider: TranslationProvider): ITranslationProvider {
  const instance = providerInstances[provider];
  if (!instance) {
    throw new Error(`Unsupported translation provider: ${provider}`);
  }
  return instance;
}
