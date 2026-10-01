/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TranslateModal } from './TranslateModal';
import apiService from '../../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../services/api', () => ({
  default: {
    translateMessage: vi.fn(),
  },
}));

describe('TranslateModal', () => {
  const onClose = vi.fn();
  const onApply = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <TranslateModal
        isOpen={false}
        onClose={onClose}
        initialText="Hello"
        onApply={onApply}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render with initial text and calculate byte length', () => {
    render(
      <TranslateModal
        isOpen={true}
        onClose={onClose}
        initialText="Hello world"
        onApply={onApply}
      />
    );

    expect(screen.getByText(/Translate Outgoing Message/i)).toBeDefined();
    const textarea = screen.getByPlaceholderText(/Enter text to translate/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Hello world');
    expect(screen.getByText(/11 chars • 11 \/ 200 bytes/i)).toBeDefined();
  });

  it('should trigger translation on button click and display result', async () => {
    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: 'Hola mundo',
      detectedSourceLanguage: 'en',
      sourceText: 'Hello world',
      targetLanguage: 'es',
    });

    render(
      <TranslateModal
        isOpen={true}
        onClose={onClose}
        initialText="Hello world"
        onApply={onApply}
        defaultTargetLanguage="es"
      />
    );

    const translateBtn = screen.getByRole('button', { name: /Translate$/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText('Hola mundo')).toBeDefined();
    });

    expect(apiService.translateMessage).toHaveBeenCalledWith({
      text: 'Hello world',
      sourceLang: undefined,
      targetLang: 'es',
    });

    // Apply button should now be enabled
    const applyBtn = screen.getByRole('button', { name: /Replace in Draft/i });
    expect(applyBtn).toBeDefined();
    fireEvent.click(applyBtn);

    expect(onApply).toHaveBeenCalledWith('Hola mundo');
    expect(onClose).toHaveBeenCalled();
  });

  it('should show packet size warning when translated text exceeds 200 bytes', async () => {
    const longString = '日本語'.repeat(70); // 3 * 70 = 210 bytes
    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: longString,
      detectedSourceLanguage: 'en',
      sourceText: 'Hello',
      targetLanguage: 'ja',
    });

    render(
      <TranslateModal
        isOpen={true}
        onClose={onClose}
        initialText="Hello"
        onApply={onApply}
      />
    );

    const translateBtn = screen.getByRole('button', { name: /Translate$/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText(/LoRa Packet Payload Warning/i)).toBeDefined();
    });
  });

  it('should persist target language to localStorage on change', () => {
    localStorage.clear();

    render(
      <TranslateModal
        isOpen={true}
        onClose={onClose}
        initialText="Hello"
        onApply={onApply}
        defaultTargetLanguage="ja"
      />
    );

    const select = screen.getByLabelText(/Target Language/i) as HTMLSelectElement;
    expect(select.value).toBe('ja');

    fireEvent.change(select, { target: { value: 'de' } });
    expect(localStorage.getItem('meshmonitor_translation_outbound_lang')).toBe('de');
  });

  it('should display error message when message translation is skipped by backend', async () => {
    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: 'ok',
      sourceText: 'ok',
      targetLanguage: 'ja',
      skipped: true,
      skipReason: 'non_conversational',
      provider: 'passthrough',
    });

    render(
      <TranslateModal
        isOpen={true}
        onClose={onClose}
        initialText="ok"
        onApply={onApply}
        defaultTargetLanguage="ja"
      />
    );

    const translateBtn = screen.getByRole('button', { name: /Translate$/i });
    fireEvent.click(translateBtn);

    await waitFor(() => {
      expect(screen.getByText(/Message not translated/i)).toBeDefined();
    });
  });
});
