/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TranslationConfigSection, type TranslationConfigSectionProps } from './TranslationConfigSection';
import apiService from '../../services/api';
import type { TranslationProvider } from '../../types/translation';
import {
  TRANSLATION_PROVIDER_DESCRIPTORS,
  TRANSLATION_PROVIDER_IDS,
  emptyTranslationProviderFieldValues,
  getTranslationProviderFields,
  type TranslationProviderFieldValues,
} from '../../types/translationProviders';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../services/api', () => ({
  default: {
    testTranslationConfig: vi.fn(),
  },
}));

/** A distinct value in every provider field, so a leak is visible. */
function distinctValues(): TranslationProviderFieldValues {
  const values = emptyTranslationProviderFieldValues();
  for (const key of Object.keys(values) as Array<keyof TranslationProviderFieldValues>) values[key] = `value-${key}`;
  return values;
}

describe('TranslationConfigSection', () => {
  const onEnabledChange = vi.fn();
  const onProviderChange = vi.fn();
  const onFieldChange = vi.fn();
  const onDefaultLanguageChange = vi.fn();
  const onDefaultOutgoingLanguageChange = vi.fn();

  const renderSection = (overrides: Partial<TranslationConfigSectionProps> = {}) =>
    render(
      <TranslationConfigSection
        enabled={true}
        onEnabledChange={onEnabledChange}
        provider="libretranslate"
        onProviderChange={onProviderChange}
        values={emptyTranslationProviderFieldValues()}
        onFieldChange={onFieldChange}
        defaultLanguage="en"
        onDefaultLanguageChange={onDefaultLanguageChange}
        defaultOutgoingLanguage="ja"
        onDefaultOutgoingLanguageChange={onDefaultOutgoingLanguageChange}
        {...overrides}
      />
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render provider selection and toggle', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: /Message Translation/i })).toBeDefined();
    const checkbox = screen.getByTestId('translation-enabled-toggle') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('lists every provider from the descriptors, labelled by its i18n key', () => {
    renderSection();
    const select = screen.getByTestId('translation-provider-select') as HTMLSelectElement;
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([...TRANSLATION_PROVIDER_IDS]);
    expect(options.map((o) => o.textContent)).toEqual(
      TRANSLATION_PROVIDER_IDS.map((id) => TRANSLATION_PROVIDER_DESCRIPTORS[id].labelKey));

    fireEvent.change(select, { target: { value: 'deepl' } });
    expect(onProviderChange).toHaveBeenCalledWith('deepl');
  });

  it('hides every provider field while translation is disabled', () => {
    renderSection({ enabled: false, values: distinctValues() });
    expect(screen.queryByTestId('translation-provider-select')).toBeNull();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  describe.each(TRANSLATION_PROVIDER_IDS.map((id) => [id] as const))('provider %s', (provider) => {
    const own = getTranslationProviderFields(provider);
    const others = TRANSLATION_PROVIDER_IDS
      .filter((id) => id !== provider)
      .flatMap((id) => [...getTranslationProviderFields(id)]);

    it('renders exactly its own inputs, each with its own label, value and kind', () => {
      const values = distinctValues();
      renderSection({ provider, values });

      for (const field of own) {
        const input = screen.getByTestId(`${field.inputId}-input`) as HTMLInputElement;
        expect(input.id).toBe(field.inputId);
        expect(input.value).toBe(values[field.settingKey]);
        expect(input.type).toBe(field.kind === 'secret' ? 'password' : 'text');
        expect(input.getAttribute('aria-required')).toBe(String(field.required));
        // The label is the field's OWN i18n key (the shared-key bug, #5518).
        expect(document.querySelector(`label[for="${field.inputId}"]`)?.textContent).toContain(field.labelKey);
      }
      for (const field of others) {
        expect(screen.queryByTestId(`${field.inputId}-input`)).toBeNull();
      }
    });

    it('never shows another provider\'s value', () => {
      const values = distinctValues();
      const { container } = renderSection({ provider, values });
      const shown = Array.from(container.querySelectorAll('input')).map((i) => i.value);
      for (const field of others) {
        expect(shown).not.toContain(values[field.settingKey]);
        expect(container.innerHTML).not.toContain(values[field.settingKey]);
      }
    });

    it('onFieldChange carries the settings key of the edited field', () => {
      renderSection({ provider, values: distinctValues() });
      for (const field of own) {
        onFieldChange.mockClear();
        fireEvent.change(screen.getByTestId(`${field.inputId}-input`), { target: { value: 'typed' } });
        expect(onFieldChange).toHaveBeenCalledTimes(1);
        expect(onFieldChange).toHaveBeenCalledWith(field.settingKey, 'typed');
      }
    });

    it('Test Connection sends only this provider\'s fields', async () => {
      vi.mocked(apiService.testTranslationConfig).mockResolvedValue({
        translatedText: 'Hola', sourceText: 'Hello', targetLanguage: 'es', sampleSourceText: 'Hello',
      });
      const values = distinctValues();
      renderSection({ provider, values, defaultOutgoingLanguage: 'es' });

      fireEvent.click(screen.getByTestId('translation-test-button'));
      await waitFor(() => expect(apiService.testTranslationConfig).toHaveBeenCalledTimes(1));

      expect(apiService.testTranslationConfig).toHaveBeenCalledWith({
        provider,
        ...Object.fromEntries(own.map((f) => [f.configKey, values[f.settingKey]])),
        targetLanguage: 'es',
        sourceLanguage: 'en',
      });
      const sent = JSON.stringify(vi.mocked(apiService.testTranslationConfig).mock.calls[0][0]);
      for (const field of others) expect(sent).not.toContain(values[field.settingKey]);
    });
  });

  it('switching provider swaps the key input and its value', () => {
    const values = distinctValues();
    const props = { values };
    const { rerender, container } = renderSection({ ...props, provider: 'deepl' });
    expect((screen.getByTestId('deepl-api-key-input') as HTMLInputElement).value).toBe(values.translationDeeplApiKey);

    const switchTo = (provider: TranslationProvider) => rerender(
      <TranslationConfigSection
        enabled={true}
        onEnabledChange={onEnabledChange}
        provider={provider}
        onProviderChange={onProviderChange}
        values={values}
        onFieldChange={onFieldChange}
        defaultLanguage="en"
        onDefaultLanguageChange={onDefaultLanguageChange}
        defaultOutgoingLanguage="ja"
        onDefaultOutgoingLanguageChange={onDefaultOutgoingLanguageChange}
      />
    );

    switchTo('openai');
    expect(screen.queryByTestId('deepl-api-key-input')).toBeNull();
    expect((screen.getByTestId('openai-api-key-input') as HTMLInputElement).value).toBe(values.translationOpenAiApiKey);
    expect(container.innerHTML).not.toContain(values.translationDeeplApiKey);
  });

  it('should show the sample translation when the test succeeds', async () => {
    vi.mocked(apiService.testTranslationConfig).mockResolvedValue({
      translatedText: 'Hola mundo',
      detectedSourceLanguage: 'en',
      sourceText: 'Hello world',
      targetLanguage: 'es',
      sampleSourceText: 'Hello world',
    });
    renderSection();

    fireEvent.click(screen.getByTestId('translation-test-button'));

    await waitFor(() => {
      expect(screen.getByText(/Success! Sample translation: "Hola mundo"/i)).toBeDefined();
    });
  });

  it.each(['deepl', 'google'] as const)('does not call the server when %s has no key', async (provider) => {
    renderSection({ provider });

    fireEvent.click(screen.getByTestId('translation-test-button'));

    const keyField = getTranslationProviderFields(provider).find((f) => f.required)!;
    await waitFor(() => {
      expect(screen.getByText(`${keyField.labelKey} is required`)).toBeDefined();
    });
    expect(apiService.testTranslationConfig).not.toHaveBeenCalled();
  });
});
