/**
 * AutomationBuilder — cooldown advice for connection system events (#6437).
 * The note shows for source-connected / source-disconnected only.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AutomationBuilder from './AutomationBuilder';
import type { WorkflowForm } from './compile';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

function renderFor(type: string, event?: string) {
  const form: WorkflowForm = {
    trigger: { type, params: event ? { event } : {} },
    rules: [{ conditions: [], actions: [{ type: 'action.nothing', params: {} }] }],
    combine: null,
  };
  return render(
    <AutomationBuilder form={form} variables={[]} sources={[]} channels={[]} scripts={[]} regions={[]} onChange={() => {}} />,
  );
}

describe('connection event cooldown note', () => {
  it.each(['source-connected', 'source-disconnected'])('shows for %s', (event) => {
    renderFor('trigger.system', event);
    expect(screen.getByTestId('connection-event-cooldown-note').textContent).toContain('10 minutes or more');
  });

  it('is hidden for other system events and other triggers', () => {
    const { unmount } = renderFor('trigger.system', 'bootup');
    expect(screen.queryByTestId('connection-event-cooldown-note')).toBeNull();
    unmount();
    renderFor('trigger.message');
    expect(screen.queryByTestId('connection-event-cooldown-note')).toBeNull();
  });
});
