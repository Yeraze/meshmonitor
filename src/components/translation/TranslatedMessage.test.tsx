/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TranslatedMessage } from './TranslatedMessage';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

describe('TranslatedMessage', () => {
  const onDismiss = vi.fn();
  const onRetry = vi.fn();
  const onChangeTargetLang = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state', () => {
    render(
      <TranslatedMessage
        state={{ loading: true }}
        onDismiss={onDismiss}
      />
    );
    expect(screen.getByText(/Translating.../i)).toBeDefined();
  });

  it('should render error state with retry and dismiss buttons', () => {
    render(
      <TranslatedMessage
        state={{ loading: false, error: 'Network failure' }}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Network failure')).toBeDefined();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('should render translated text and call onChangeTargetLang when target language is changed', () => {
    render(
      <TranslatedMessage
        state={{
          loading: false,
          text: 'こんにちは',
          detectedSourceLang: 'en',
          targetLang: 'ja',
        }}
        onDismiss={onDismiss}
        onChangeTargetLang={onChangeTargetLang}
      />
    );

    expect(screen.getByText('こんにちは')).toBeDefined();
    expect(screen.getByText('EN')).toBeDefined();

    const select = screen.getByTestId('inline-target-lang-select') as HTMLSelectElement;
    expect(select.value).toBe('ja');

    fireEvent.change(select, { target: { value: 'es' } });
    expect(onChangeTargetLang).toHaveBeenCalledWith('es');
  });

  it('should call onDismiss when close button is clicked', () => {
    render(
      <TranslatedMessage
        state={{
          loading: false,
          text: 'Bonjour',
          targetLang: 'fr',
        }}
        onDismiss={onDismiss}
      />
    );

    const dismissBtn = screen.getByTitle('Hide translation');
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalled();
  });
});
