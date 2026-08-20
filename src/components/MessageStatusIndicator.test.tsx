/**
 * @vitest-environment jsdom
 *
 * #4816 Phase 1 WP3 — MessageStatusIndicator was refactored to consume the
 * shared `getMeshtasticDeliveryState` selector (src/utils/deliveryDiagnostics/status.ts)
 * instead of re-implementing the failed/confirmed/delivered/pending/timeout
 * branching inline, and gained an optional `onShowDetails` prop that turns
 * the icon into a clickable button opening the Delivery Details modal.
 *
 * These tests guard two things:
 *  1. The refactor is behavior-identical — same icon/tone/title for every
 *     delivery state as before the shared-helper extraction.
 *  2. The new `onShowDetails` affordance is additive and backward-compatible:
 *     omitting it must still render the original, non-interactive `<span>`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import { MeshMessage, MessageDeliveryState } from '../types/message';

const NOW = 1_700_000_000_000;

function baseMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: 'msg-1',
    from: '!aaaaaaaa',
    to: '!bbbbbbbb',
    fromNodeId: '!aaaaaaaa',
    toNodeId: '!bbbbbbbb',
    text: 'hello',
    channel: 0,
    timestamp: new Date(NOW),
    ...overrides,
  };
}

// Table-drives every delivery state → expected className/icon/title, mirroring
// the state table in getMeshtasticDeliveryState's own unit tests so the icon
// and the shared selector can never silently drift apart.
const STATE_CASES: Array<{
  name: string;
  message: MeshMessage;
  className: string;
  iconName: string;
  titleKey: string;
}> = [
  {
    name: 'failed (ackFailed)',
    message: baseMessage({ ackFailed: true }),
    className: 'status-failed',
    iconName: 'error',
    titleKey: 'message_status.failed',
  },
  {
    name: 'failed (routingErrorReceived)',
    message: baseMessage({ routingErrorReceived: true }),
    className: 'status-failed',
    iconName: 'error',
    titleKey: 'message_status.failed',
  },
  {
    name: 'failed (deliveryState FAILED)',
    message: baseMessage({ deliveryState: MessageDeliveryState.FAILED }),
    className: 'status-failed',
    iconName: 'error',
    titleKey: 'message_status.failed',
  },
  {
    name: 'confirmed',
    message: baseMessage({ deliveryState: MessageDeliveryState.CONFIRMED }),
    className: 'status-confirmed',
    iconName: 'encrypted',
    titleKey: 'message_status.confirmed',
  },
  {
    name: 'delivered',
    message: baseMessage({ deliveryState: MessageDeliveryState.DELIVERED }),
    className: 'status-delivered',
    iconName: 'check',
    titleKey: 'message_status.delivered',
  },
  {
    name: 'pending (recent, no deliveryState)',
    message: baseMessage({ timestamp: new Date() }),
    className: 'status-pending',
    iconName: 'time',
    titleKey: 'message_status.pending',
  },
  {
    name: 'timeout (old, no deliveryState)',
    message: baseMessage({ timestamp: new Date(Date.now() - 60_000) }),
    className: 'status-timeout',
    iconName: 'timer',
    titleKey: 'message_status.timeout',
  },
];

describe('MessageStatusIndicator', () => {
  describe.each(STATE_CASES)('$name', ({ message, className, iconName, titleKey }) => {
    it('renders the same icon/tone/title as a span when onShowDetails is absent (backward-compat)', () => {
      render(<MessageStatusIndicator message={message} />);

      const el = screen.getByTitle(titleKey);
      expect(el.tagName).toBe('SPAN');
      expect(el).toHaveClass(className);
      expect(el.querySelector(`[data-ui-icon="${iconName}"]`)).toBeInTheDocument();
    });

    it('renders the same icon/tone/title as a button when onShowDetails is provided', () => {
      render(<MessageStatusIndicator message={message} onShowDetails={vi.fn()} />);

      const el = screen.getByTitle(titleKey);
      expect(el.tagName).toBe('BUTTON');
      expect(el).toHaveClass(className);
      expect(el).toHaveAttribute('aria-label', titleKey);
      expect(el.querySelector(`[data-ui-icon="${iconName}"]`)).toBeInTheDocument();
    });
  });

  it('does not render a button when onShowDetails is omitted', () => {
    render(<MessageStatusIndicator message={baseMessage({ deliveryState: MessageDeliveryState.DELIVERED })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onShowDetails when the button is clicked', async () => {
    const onShowDetails = vi.fn();
    render(
      <MessageStatusIndicator
        message={baseMessage({ deliveryState: MessageDeliveryState.DELIVERED })}
        onShowDetails={onShowDetails}
      />
    );

    await userEvent.click(screen.getByRole('button'));
    expect(onShowDetails).toHaveBeenCalledTimes(1);
  });

  it('is a submit-safe button so a stray Enter cannot post an enclosing form', () => {
    render(
      <MessageStatusIndicator
        message={baseMessage({ deliveryState: MessageDeliveryState.DELIVERED })}
        onShowDetails={vi.fn()}
      />
    );
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
