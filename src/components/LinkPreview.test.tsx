/**
 * @vitest-environment jsdom
 *
 * Tests the global "link previews enabled" gate (issue #3416) on the
 * LinkPreview component. When the setting is off, the component must render
 * nothing AND never call the backend — that's the privacy guarantee.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import LinkPreview from './LinkPreview';

// Controllable setting value, hoisted so the mock factory can close over it.
const { settingState } = vi.hoisted(() => ({ settingState: { linkPreviewsEnabled: true } }));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettingsOptional: () => ({ linkPreviewsEnabled: settingState.linkPreviewsEnabled }),
}));

// extractUrls always finds a URL; fetchLinkPreview is a spy we assert against.
const fetchLinkPreviewMock = vi.fn(async () => ({ url: 'https://example.com', title: 'Example' }));
const { realExtract } = vi.hoisted(() => ({ realExtract: { on: false } }));
vi.mock('../utils/linkRenderer', async () => {
  const actual = await vi.importActual<typeof import('../utils/linkRenderer')>('../utils/linkRenderer');
  return {
    extractUrls: (text: string) => (realExtract.on ? actual.extractUrls(text) : ['https://example.com']),
    fetchLinkPreview: (...args: unknown[]) => fetchLinkPreviewMock(...args),
  };
});

describe('LinkPreview link-preview gate', () => {
  beforeEach(() => {
    fetchLinkPreviewMock.mockClear();
    settingState.linkPreviewsEnabled = true;
    realExtract.on = false;
    // Minimal IntersectionObserver stub for jsdom (component uses lazy loading).
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders nothing and makes no request when previews are disabled', () => {
    settingState.linkPreviewsEnabled = false;
    const { container } = render(<LinkPreview text="check https://example.com" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchLinkPreviewMock).not.toHaveBeenCalled();
  });

  it('renders a container when previews are enabled', () => {
    settingState.linkPreviewsEnabled = true;
    const { container } = render(<LinkPreview text="check https://example.com" />);
    // The lazy-loading container is present (fetch only fires on intersection).
    expect(container.querySelector('.link-preview-container')).toBeInTheDocument();
  });

  it('sets up no observer and no fetch for an MCOimg payload containing a URL (#6586)', () => {
    realExtract.on = true;
    const observe = vi.fn();
    (globalThis as any).IntersectionObserver = class {
      observe = observe;
      unobserve() {}
      disconnect() {}
    };
    const { container } = render(<LinkPreview text="im3:abcdhttp://x.yEFGH" />);
    expect(container).toBeEmptyDOMElement();
    expect(observe).not.toHaveBeenCalled();
    expect(fetchLinkPreviewMock).not.toHaveBeenCalled();
  });
});
