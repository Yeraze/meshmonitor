/**
 * @vitest-environment jsdom
 *
 * BulkActionMenu (#4964 report reorganization, WP5, spec §6.4/§10.5/§11 WP5
 * acceptance): hidden entirely when `!canAct`; every destructive item opens
 * a confirm dialog before firing its callback; the mute item and muted
 * marker follow `mute.muted`; dismiss/restore items are hidden at 0 count.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) Object.entries(options).forEach(([k, v]) => { result = result.replace(`{{${k}}}`, String(v)); });
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import BulkActionMenu from './BulkActionMenu';

const noop = () => {};

describe('BulkActionMenu', () => {
  it('renders nothing when canAct is false', () => {
    const { container } = render(
      <BulkActionMenu
        canAct={false}
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={2}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the popover and lists Dismiss all / Restore all / Mute this rule with their counts', () => {
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={2}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending={false}
        mute={{ muted: false, onMute: noop }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Dismiss all 5' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Restore all 2 dismissed' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mute this rule' })).toBeInTheDocument();
  });

  it('hides Dismiss all / Restore all when their counts are 0', () => {
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={0}
        dismissedCount={0}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending={false}
        mute={{ muted: false, onMute: noop }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.queryByRole('menuitem', { name: /Dismiss all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Restore all/ })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mute this rule' })).toBeInTheDocument();
  });

  it('clicking Dismiss all opens a confirm dialog and does NOT call onDismissAll until confirmed', () => {
    const onDismissAll = vi.fn();
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={0}
        onDismissAll={onDismissAll}
        onRestoreAll={noop}
        bulkPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dismiss all 5' }));

    expect(onDismissAll).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('bulk-confirm-dialog')).toHaveTextContent('5');
    expect(screen.getByTestId('bulk-confirm-dialog')).toHaveTextContent('B7 Coverage shadow');

    fireEvent.click(screen.getByTestId('bulk-confirm-go'));
    expect(onDismissAll).toHaveBeenCalledTimes(1);
  });

  it('cancelling the confirm dialog never calls the callback', () => {
    const onDismissAll = vi.fn();
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={0}
        onDismissAll={onDismissAll}
        onRestoreAll={noop}
        bulkPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dismiss all 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDismissAll).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('restore all opens its own confirm and calls onRestoreAll on confirm', () => {
    const onRestoreAll = vi.fn();
    render(
      <BulkActionMenu
        canAct
        subjectLabel="node Alpha"
        openCount={0}
        dismissedCount={3}
        onDismissAll={noop}
        onRestoreAll={onRestoreAll}
        bulkPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore all 3 dismissed' }));
    fireEvent.click(screen.getByTestId('bulk-confirm-go'));
    expect(onRestoreAll).toHaveBeenCalledTimes(1);
  });

  it('shows the Muted marker and hides "Mute this rule" once mute.muted is true', () => {
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={0}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending={false}
        mute={{ muted: true, onMute: noop }}
      />,
    );
    expect(screen.getByText('Muted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.queryByRole('menuitem', { name: 'Mute this rule' })).not.toBeInTheDocument();
  });

  it('has no mute item at all for a node-scope menu (mute prop omitted)', () => {
    render(
      <BulkActionMenu
        canAct
        subjectLabel="node Alpha"
        openCount={5}
        dismissedCount={2}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.queryByRole('menuitem', { name: /Mute/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Muted')).not.toBeInTheDocument();
  });

  it('disables the dismiss/restore menu items while a bulk mutation is pending', () => {
    render(
      <BulkActionMenu
        canAct
        subjectLabel="B7 Coverage shadow"
        openCount={5}
        dismissedCount={2}
        onDismissAll={noop}
        onRestoreAll={noop}
        bulkPending
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Dismiss all 5' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Restore all 2 dismissed' })).toBeDisabled();
  });
});
