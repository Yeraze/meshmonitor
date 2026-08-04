/**
 * @vitest-environment jsdom
 *
 * MeshCoreMessageStream.disabledReason (#4547 Phase 2 WP1) — the composer's
 * `disabled` control must be able to say *why*, mirroring
 * `TracerouteBody.runDisabledReason`. The `disabledReason` prop puts a
 * `title` on the input, the Send button, and their shared `.meshcore-send-bar`
 * parent (a `title` on a disabled <button> does not reliably fire hover).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';

const REASON = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

describe('MeshCoreMessageStream disabledReason', () => {
  it('puts the title on the input, the Send button, and the send-bar parent when disabled', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={[]} disabled disabledReason={REASON} onSend={async () => true} />,
    );
    const bar = container.querySelector('.meshcore-send-bar');
    const input = container.querySelector('input');
    const button = container.querySelector('.meshcore-send-bar button');

    expect(bar).toHaveAttribute('title', REASON);
    expect(input).toHaveAttribute('title', REASON);
    expect(button).toHaveAttribute('title', REASON);
    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
  });

  it('leaves title undefined when disabledReason is omitted (no behavior change)', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={[]} disabled onSend={async () => true} />,
    );
    const bar = container.querySelector('.meshcore-send-bar');
    const input = container.querySelector('input');
    const button = container.querySelector('.meshcore-send-bar button');

    expect(bar).not.toHaveAttribute('title');
    expect(input).not.toHaveAttribute('title');
    expect(button).not.toHaveAttribute('title');
  });

  it('does not set title when not disabled, even if disabledReason is provided', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={[]} disabledReason={REASON} onSend={async () => true} />,
    );
    const bar = container.querySelector('.meshcore-send-bar');
    const input = container.querySelector('input');

    expect(bar).not.toHaveAttribute('title');
    expect(input).not.toHaveAttribute('title');
    expect(input).not.toBeDisabled();
  });
});
