/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SpipImage } from './SpipImage';
import { parseSpip } from '../../utils/spip';

describe('SpipImage', () => {
  it('draws one rect per pixel at its grid position', () => {
    const code = '3:yzyzyzyzy';
    const { container } = render(<SpipImage image={parseSpip(code)!} code={code} />);
    const svg = screen.getByTestId('spip-image');
    expect(svg.getAttribute('viewBox')).toBe('0 0 3 3');
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(9);
    expect(rects[4].getAttribute('x')).toBe('1');
    expect(rects[4].getAttribute('y')).toBe('1');
    expect(rects[4].getAttribute('fill')).toBe('#000000');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(code);
  });
});

describe('renderMessageWithLinks SPIP messages', () => {
  it('draws a SPIP message as an image', async () => {
    const { renderMessageWithLinks } = await import('../../utils/linkRenderer');
    render(<div>{renderMessageWithLinks('3:yzyzyzyzy')}</div>);
    expect(screen.getByTestId('spip-image')).toBeTruthy();
  });

  it('leaves ordinary text alone', async () => {
    const { renderMessageWithLinks } = await import('../../utils/linkRenderer');
    render(<div>{renderMessageWithLinks('meet at 12:30')}</div>);
    expect(screen.queryByTestId('spip-image')).toBeNull();
    expect(screen.getByText('meet at 12:30')).toBeTruthy();
  });
});
