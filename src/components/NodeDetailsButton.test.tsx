/**
 * @vitest-environment jsdom
 *
 * Issue #4379 — the node list needs one consistent, visibly-interactive route
 * to Node Details, instead of the #4333 arrangement where the only clickable
 * thing in the row's icon strip was the unmessageable badge, styled exactly
 * like the inert status icons beside it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeDetailsButton } from './NodeDetailsButton';

describe('NodeDetailsButton', () => {
  it('renders as a real button', () => {
    render(<NodeDetailsButton onOpenDetails={vi.fn()} />);

    expect(screen.getByTestId('node-details-button').tagName).toBe('BUTTON');
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens node details when clicked', async () => {
    const onOpenDetails = vi.fn();
    render(<NodeDetailsButton onOpenDetails={onOpenDetails} />);

    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('describes the destination as details rather than messaging', () => {
    render(<NodeDetailsButton onOpenDetails={vi.fn()} />);
    const button = screen.getByTestId('node-details-button');

    // i18n is unconfigured under jsdom, so t() echoes the key. Pinning the key
    // catches a swap back to a messaging-flavoured string — naming the
    // destination after messaging is the conceptual mismatch #4379 was filed
    // over, since Node Details covers far more than DMs.
    expect(button).toHaveAttribute('aria-label', 'nodes.open_details');
    expect(button).toHaveAttribute('title', 'nodes.open_details');
  });

  it('carries its own chrome rather than borrowing the inert-indicator look', () => {
    render(<NodeDetailsButton onOpenDetails={vi.fn()} />);
    const button = screen.getByTestId('node-details-button');

    // The bare glyph in #4333 was indistinguishable from the status icons. The
    // button must not fall back into that class.
    expect(button).not.toHaveClass('node-indicator-icon');
    expect(button.className).not.toBe('');
  });

  it('is a submit-safe button so a stray Enter cannot post an enclosing form', () => {
    render(<NodeDetailsButton onOpenDetails={vi.fn()} />);
    expect(screen.getByTestId('node-details-button')).toHaveAttribute('type', 'button');
  });
});
