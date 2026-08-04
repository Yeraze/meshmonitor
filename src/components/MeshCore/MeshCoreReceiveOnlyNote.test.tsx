/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';

describe('MeshCoreReceiveOnlyNote', () => {
  it('renders null when receiveOnly is false', () => {
    const { container } = render(<MeshCoreReceiveOnlyNote receiveOnly={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when receiveOnly is omitted', () => {
    const { container } = render(<MeshCoreReceiveOnlyNote />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the paused-note string and a UiIcon (not an emoji) when receiveOnly is true', () => {
    render(<MeshCoreReceiveOnlyNote receiveOnly />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(
      'Paused — receive-only mode. These settings are saved and unchanged; they take effect again when receive-only is turned off.',
    );
    // Default icon style is lucide (SVG), never a literal emoji glyph.
    expect(note.querySelector('svg')).not.toBeNull();
  });
});
