/**
 * @vitest-environment jsdom
 *
 * Issue #4379 — the unmessageable badge is an inert status indicator again.
 *
 * #4326 gave unmessageable nodes a badge in place of the Send-DM button, and
 * #4333 made that badge clickable so the node list stopped being a dead end.
 * #4379 rejected the *placement*: it was the one interactive element in a row
 * of look-alike inert icons, and it hung "go to Node Details" off a messaging
 * icon. The route to details now lives in NodeDetailsButton, on every row, so
 * this badge must go back to being purely informational.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeUnmessageableBadge } from './NodeUnmessageableBadge';

describe('NodeUnmessageableBadge', () => {
  it('renders as an inert indicator, not a control', () => {
    render(<NodeUnmessageableBadge />);

    const badge = screen.getByTestId('node-unmessageable-badge');
    expect(badge.tagName).toBe('SPAN');
    // The regression #4379 guards against is this badge becoming clickable
    // again. Nothing in the indicator group should be exposed as a control.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sits in the indicator group so it matches the other status icons', () => {
    render(<NodeUnmessageableBadge />);

    // Sharing `.node-indicator-icon` with location/MQTT/telemetry is what makes
    // it *look* inert. A bespoke class would let it drift back into looking
    // interactive, which is the whole complaint in #4379.
    expect(screen.getByTestId('node-unmessageable-badge')).toHaveClass('node-indicator-icon');
  });

  it('explains itself with the pre-existing translated sentence and nothing else', () => {
    render(<NodeUnmessageableBadge />);
    const badge = screen.getByTestId('node-unmessageable-badge');

    // i18n is unconfigured under jsdom, so t() echoes the key — which lets this
    // pin the exact key rather than the English fallback. The "click to open
    // its details" half that #4333 appended is gone along with the click.
    expect(badge).toHaveAttribute('title', 'nodes.unmessageable');
  });
});
