/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TranslationConfigSection } from './TranslationConfigSection';
import apiService from '../../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../services/api', () => ({
  default: {
    testTranslationConfig: vi.fn(),
  },
}));

describe('TranslationConfigSection', () => {
  const onEnabledChange = vi.fn();
  const onProviderChange = vi.fn();
  const onUrlChange = vi.fn();
  const onApiKeyChange = vi.fn();
  const onModelChange = vi.fn();
  const onOpenAiBaseUrlChange = vi.fn();
  const onDefaultLanguageChange = vi.fn();
  const onDefaultOutgoingLanguageChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render provider selection and toggle', () => {
    render(
      <TranslationConfigSection
        enabled={true}
        onEnabledChange={onEnabledChange}
        provider="libretranslate"
        onProviderChange={onProviderChange}
        url="http://libretranslate:5000"
        onUrlChange={onUrlChange}
        apiKey=""
        onApiKeyChange={onApiKeyChange}
        model=""
        onModelChange={onModelChange}
        openAiBaseUrl=""
        onOpenAiBaseUrlChange={onOpenAiBaseUrlChange}
        defaultLanguage="en"
        onDefaultLanguageChange={onDefaultLanguageChange}
        defaultOutgoingLanguage="ja"
        onDefaultOutgoingLanguageChange={onDefaultOutgoingLanguageChange}
      />
    );

    expect(screen.getByRole('heading', { name: /Message Translation/i })).toBeDefined();
    const checkbox = screen.getByTestId('translation-enabled-toggle') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('should render OpenAI-specific fields when openai provider selected', () => {
    render(
      <TranslationConfigSection
        enabled={true}
        onEnabledChange={onEnabledChange}
        provider="openai"
        onProviderChange={onProviderChange}
        url=""
        onUrlChange={onUrlChange}
        apiKey="sk-test"
        onApiKeyChange={onApiKeyChange}
        model="gpt-4o-mini"
        onModelChange={onModelChange}
        openAiBaseUrl="http://localhost:11434/v1"
        onOpenAiBaseUrlChange={onOpenAiBaseUrlChange}
        defaultLanguage="en"
        onDefaultLanguageChange={onDefaultLanguageChange}
        defaultOutgoingLanguage="ja"
        onDefaultOutgoingLanguageChange={onDefaultOutgoingLanguageChange}
      />
    );

    expect(screen.getByTestId('openai-base-url-input')).toBeDefined();
    expect(screen.getByTestId('openai-model-input')).toBeDefined();
    expect(screen.getByTestId('openai-api-key-input')).toBeDefined();
  });

  it('should test connection when Test Connection button clicked', async () => {
    vi.mocked(apiService.testTranslationConfig).mockResolvedValue({
      translatedText: 'Hola mundo',
      detectedSourceLanguage: 'en',
      sourceText: 'Hello world',
      targetLanguage: 'es',
      sampleSourceText: 'Hello world',
    });

    render(
      <TranslationConfigSection
        enabled={true}
        onEnabledChange={onEnabledChange}
        provider="libretranslate"
        onProviderChange={onProviderChange}
        url="http://libretranslate:5000"
        onUrlChange={onUrlChange}
        apiKey=""
        onApiKeyChange={onApiKeyChange}
        model=""
        onModelChange={onModelChange}
        openAiBaseUrl=""
        onOpenAiBaseUrlChange={onOpenAiBaseUrlChange}
        defaultLanguage="en"
        onDefaultLanguageChange={onDefaultLanguageChange}
        defaultOutgoingLanguage="es"
        onDefaultOutgoingLanguageChange={onDefaultOutgoingLanguageChange}
      />
    );

    const testBtn = screen.getByTestId('translation-test-button');
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText(/Success! Sample translation: "Hola mundo"/i)).toBeDefined();
    });

    expect(apiService.testTranslationConfig).toHaveBeenCalledWith({
      provider: 'libretranslate',
      url: 'http://libretranslate:5000',
      apiKey: '',
      model: '',
      openAiBaseUrl: '',
      targetLanguage: 'es',
      sourceLanguage: 'en',
    });
  });
});
