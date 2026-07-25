/**
 * @vitest-environment jsdom
 *
 * Issue #4326 — in the node list, a node that reports itself unmessageable
 * gets this badge instead of the Send-DM button. It used to be an inert
 * <span> with no click handler, so the list offered no route at all to the
 * node's details. It must now be an actual control that opens Node Details.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeUnmessageableBadge } from './NodeUnmessageableBadge';

describe('NodeUnmessageableBadge', () => {
  it('renders as a button, not an inert badge', () => {
    render(<NodeUnmessageableBadge onOpenDetails={vi.fn()} />);
    expect(screen.getByTestId('node-unmessageable-badge').tagName).toBe('BUTTON');
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens node details when clicked', async () => {
    const onOpenDetails = vi.fn();
    render(<NodeUnmessageableBadge onOpenDetails={onOpenDetails} />);

    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing unmessageable explanation and advertises the new click path', () => {
    render(<NodeUnmessageableBadge onOpenDetails={vi.fn()} />);
    const label = screen.getByTestId('node-unmessageable-badge').getAttribute('aria-label') ?? '';

    // The already-translated sentence is reused rather than replaced, so #4326
    // costs translators one short string instead of invalidating the long one.
    expect(label).toContain('nodes.unmessageable');
    expect(label).toContain('nodes.unmessageable_open_details');
    expect(screen.getByTestId('node-unmessageable-badge')).toHaveAttribute('title', label);
  });
});
