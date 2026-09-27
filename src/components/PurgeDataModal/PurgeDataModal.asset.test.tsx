/**
 * #5354: the manual delete stays allowed for a tracked asset, with a warning
 * that its retained history goes too.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => (typeof opts === 'string' ? opts : key),
  }),
}));

import { PurgeDataModal } from './PurgeDataModal';

const noop = () => undefined;
const baseProps = {
  isOpen: true,
  onClose: noop,
  onPurgeMessages: noop,
  onPurgeTraceroutes: noop,
  onPurgeTelemetry: noop,
  onPurgePositionHistory: noop,
  onDeleteNode: noop,
  onPurgeFromDevice: noop,
  getNodeName: () => 'Node',
};

describe('PurgeDataModal asset warning (#5354)', () => {
  it('warns when the node is a tracked asset', () => {
    render(<PurgeDataModal {...baseProps} selectedNode={{ nodeNum: 1, asset: { retentionDays: 90 } }} />);
    expect(screen.getByRole('alert').textContent).toContain('tracked asset');
    // The delete buttons are still there.
    expect(screen.getByText('purgeModal.deleteLocal')).toBeTruthy();
  });

  it('shows no warning for a plain node', () => {
    render(<PurgeDataModal {...baseProps} selectedNode={{ nodeNum: 1 }} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
