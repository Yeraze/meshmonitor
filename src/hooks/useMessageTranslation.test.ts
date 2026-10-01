/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageTranslation } from './useMessageTranslation';
import apiService from '../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../services/api', () => ({
  default: {
    translateMessage: vi.fn(),
  },
}));

describe('useMessageTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should manage translation state lifecycle', async () => {
    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: 'こんにちは',
      detectedSourceLanguage: 'en',
      sourceText: 'Hello',
      targetLanguage: 'ja',
      provider: 'openai',
    });

    const { result } = renderHook(() => useMessageTranslation());

    expect(result.current.translatedMessages).toEqual({});

    let promise: Promise<void>;
    act(() => {
      promise = result.current.translateMessage('msg-1', 'Hello', 'ja');
    });

    // Should be in loading state
    expect(result.current.translatedMessages['msg-1']?.loading).toBe(true);

    await act(async () => {
      await promise;
    });

    // Should have result
    expect(result.current.translatedMessages['msg-1']).toEqual({
      loading: false,
      text: 'こんにちは',
      detectedSourceLang: 'en',
      targetLang: 'ja',
      provider: 'openai',
    });

    // Dismiss translation
    act(() => {
      result.current.dismissTranslation('msg-1');
    });

    expect(result.current.translatedMessages['msg-1']).toBeUndefined();
  });

  it('should capture translation errors', async () => {
    vi.mocked(apiService.translateMessage).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useMessageTranslation());

    await act(async () => {
      await result.current.translateMessage('msg-2', 'Test text');
    });

    expect(result.current.translatedMessages['msg-2']).toEqual({
      loading: false,
      error: 'Network error',
    });
  });

  it('should use and persist preferred inbound language from localStorage', async () => {
    localStorage.clear();
    localStorage.setItem('meshmonitor_translation_inbound_lang', 'de');

    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: 'Hallo',
      detectedSourceLanguage: 'en',
      sourceText: 'Hello',
      targetLanguage: 'de',
    });

    const { result } = renderHook(() => useMessageTranslation());

    // Call without explicit target language — should use localStorage 'de'
    await act(async () => {
      await result.current.translateMessage('msg-3', 'Hello');
    });

    expect(apiService.translateMessage).toHaveBeenCalledWith({
      text: 'Hello',
      targetLang: 'de',
    });

    // Call with explicit target language 'fr' — should update localStorage to 'fr'
    await act(async () => {
      await result.current.translateMessage('msg-3', 'Hello', 'fr');
    });

    expect(localStorage.getItem('meshmonitor_translation_inbound_lang')).toBe('fr');
  });

  it('should treat skipped messages as error/info state rather than active translation text', async () => {
    vi.mocked(apiService.translateMessage).mockResolvedValue({
      translatedText: '73',
      sourceText: '73',
      targetLanguage: 'ja',
      skipped: true,
      skipReason: 'non_conversational',
      provider: 'passthrough',
    });

    const { result } = renderHook(() => useMessageTranslation());

    await act(async () => {
      await result.current.translateMessage('msg-4', '73', 'ja');
    });

    expect(result.current.translatedMessages['msg-4']).toEqual({
      loading: false,
      error: 'Message not translated (telemetry, test ping, or emoji)',
    });
  });
});
