/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../contexts/IconStyleContext', () => ({
  useIconStyleOptional: () => 'lucide' as const,
}));

import { SourceNav, type SourceNavSection } from './SourceNav';

const sections: SourceNavSection[] = [
  {
    title: 'Main',
    items: [
      { id: 'nodes', label: 'Nodes', icon: 'nodes', onClick: () => {} },
      { id: 'channels', label: 'Channels', icon: 'channels', onClick: () => {}, unread: true },
    ],
  },
  {
    title: 'Configuration',
    items: [{ id: 'settings', label: 'Settings', icon: 'settings', onClick: () => {} }],
  },
];

describe('SourceNav', () => {
  it('marks only the active item', () => {
    const { container } = render(
      <SourceNav sections={sections} activeId="channels" collapsed={false} />
    );
    const active = container.querySelectorAll('[data-active="true"]');
    expect(active.length).toBe(1);
    expect(active[0].getAttribute('data-source-nav-item')).toBe('channels');
    expect(active[0].getAttribute('aria-current')).toBe('page');
  });

  it('renders an unread dot only on flagged items', () => {
    const { container } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed={false} />
    );
    const dots = container.querySelectorAll('[data-source-nav-unread]');
    expect(dots.length).toBe(1);
    expect(dots[0].closest('[data-source-nav-item]')?.getAttribute('data-source-nav-item'))
      .toBe('channels');
  });

  it('fires the item onClick', () => {
    const onClick = vi.fn();
    render(
      <SourceNav
        sections={[{ items: [{ id: 'nodes', label: 'Nodes', icon: 'nodes', onClick }] }]}
        activeId="nodes"
        collapsed={false}
      />
    );
    fireEvent.click(screen.getByText('Nodes'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('hides section headers and shows tooltips when collapsed', () => {
    const { container, rerender } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed={false} />
    );
    expect(container.querySelectorAll('[data-source-nav-section-header]').length).toBe(2);
    expect(container.querySelector('[data-source-nav-item="nodes"]')?.getAttribute('title'))
      .toBeNull();

    rerender(<SourceNav sections={sections} activeId="nodes" collapsed />);
    // Collapsed rails show no text, so the tooltip is the only affordance left.
    expect(container.querySelectorAll('[data-source-nav-section-header]').length).toBe(0);
    expect(container.querySelector('[data-source-nav-item="nodes"]')?.getAttribute('title'))
      .toBe('Nodes');
  });

  it('renders the built-in toggle only when no controls slot is supplied', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <SourceNav
        sections={sections}
        activeId="nodes"
        collapsed={false}
        onToggleCollapsed={onToggle}
      />
    );
    const toggle = container.querySelector('[data-source-nav-toggle]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <SourceNav
        sections={sections}
        activeId="nodes"
        collapsed={false}
        onToggleCollapsed={onToggle}
        controls={<div data-testid="custom-controls" />}
      />
    );
    expect(container.querySelector('[data-source-nav-toggle]')).toBeNull();
    expect(screen.getByTestId('custom-controls')).toBeDefined();
  });

  it('exposes the mobile variant so consumers can opt into the bottom bar', () => {
    const { container, rerender } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed />
    );
    // Bottom bar is the default.
    expect(container.querySelector('[data-source-nav]')?.getAttribute('data-mobile-variant'))
      .toBe('bottom-bar');

    rerender(<SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="rail" />);
    expect(container.querySelector('[data-source-nav]')?.getAttribute('data-mobile-variant'))
      .toBe('rail');
  });
});
