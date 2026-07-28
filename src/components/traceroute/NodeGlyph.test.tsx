/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NodeGlyph } from './NodeGlyph';

describe('NodeGlyph', () => {
  it('renders the repeater tower silhouette for a repeater-family category', () => {
    const { container } = render(<NodeGlyph category="mtRouter" color="#0000FF" />);
    // repeaterTowerSvg's tower base — the silhouette shared by ROUTER/REPEATER.
    expect(container.querySelector('rect[x="19"][y="32"]')).toBeInTheDocument();
  });

  it('renders the companion person silhouette', () => {
    const { container } = render(<NodeGlyph category="companion" color="#22c55e" />);
    // Person silhouette: head circle at (24, 18).
    expect(container.querySelector('circle[cx="24"][cy="18"]')).toBeInTheDocument();
  });

  it('falls back to a plain hop-colored disc for the standard category (no glyph)', () => {
    const { container } = render(<NodeGlyph category="standard" color="#9ca3af" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    // plainNodeDiscSvg draws exactly one shape: the disc.
    expect(svg?.querySelectorAll('circle, rect, path').length).toBe(1);
    expect(svg?.querySelector('circle')).toHaveAttribute('stroke', '#9ca3af');
  });

  it('renders the neutral "unknown hop" placeholder when unknown is set', () => {
    const { container } = render(<NodeGlyph category="mtClient" color="#0000FF" unknown />);
    const text = container.querySelector('text');
    expect(text).toBeInTheDocument();
    expect(text?.textContent).toBe('?');
    // The dashed grey outline, not the passed-in color — unknown ignores color.
    expect(container.querySelector('circle')).toHaveAttribute('stroke-dasharray', '4 3');
  });

  it('adds the unmessagable badge when unmessagable is true', () => {
    const { container } = render(<NodeGlyph category="mtClient" color="#0000FF" unmessagable />);
    // mtClient has no dedicated glyph (standard family) -> plain disc SVG,
    // plus the badge SVG = 2 top-level <svg> elements.
    expect(container.querySelectorAll('svg').length).toBe(2);
  });

  it('omits the badge when unmessagable is not set', () => {
    const { container } = render(<NodeGlyph category="mtClient" color="#0000FF" />);
    expect(container.querySelectorAll('svg').length).toBe(1);
  });

  it('routes the color prop into the SVG stroke', () => {
    const { container } = render(<NodeGlyph category="mtRouter" color="#123456" />);
    expect(container.querySelector('circle[stroke="#123456"]')).toBeInTheDocument();
  });
});
