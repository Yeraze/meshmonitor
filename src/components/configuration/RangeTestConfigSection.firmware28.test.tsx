/**
 * @vitest-environment jsdom
 *
 * Range Test vs. firmware 2.8 (#5031).
 *
 * The Range Test module was removed outright in Meshtastic firmware 2.8. On a
 * 2.8+ node the section must stay visible and explain itself — hiding it makes
 * users think MeshMonitor broke — with every control switched off so a save
 * that the firmware would silently drop can't be attempted.
 *
 * The gate fails OPEN: `isDisabled` is only ever true when the backend
 * positively reported a 2.8+ firmware, so an unknown version behaves exactly as
 * it did before this change.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const saveBarCalls: Array<{ hasChanges: boolean }> = [];
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { hasChanges: boolean }) => {
    saveBarCalls.push({ hasChanges: opts.hasChanges });
  },
}));

import RangeTestConfigSection from './RangeTestConfigSection';

const REMOVED_NOTICE = /removed in Meshtastic 2\.8/i;

const baseProps = {
  enabled: true,
  setEnabled: vi.fn(),
  sender: 60,
  setSender: vi.fn(),
  save: false,
  setSave: vi.fn(),
  isSaving: false,
  onSave: vi.fn(async () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  saveBarCalls.length = 0;
});

describe('RangeTestConfigSection — firmware 2.8 removal notice', () => {
  it('renders the normal editable UI when the module is supported (pre-2.8)', () => {
    render(<RangeTestConfigSection {...baseProps} isDisabled={false} />);

    expect(screen.queryByText(REMOVED_NOTICE)).toBeNull();

    const enabledBox = document.getElementById('rangetestEnabled') as HTMLInputElement;
    const senderInput = document.getElementById('rangetestSender') as HTMLInputElement;
    const saveBox = document.getElementById('rangetestSave') as HTMLInputElement;

    expect(enabledBox.disabled).toBe(false);
    expect(senderInput.disabled).toBe(false);
    expect(saveBox.disabled).toBe(false);
  });

  it('behaves exactly as today when the firmware version is unknown (prop omitted)', () => {
    render(<RangeTestConfigSection {...baseProps} />);

    expect(screen.queryByText(REMOVED_NOTICE)).toBeNull();
    expect((document.getElementById('rangetestEnabled') as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById('rangetestSender') as HTMLInputElement).disabled).toBe(false);
  });

  it('shows the removal notice and disables every control on 2.8+', () => {
    render(<RangeTestConfigSection {...baseProps} isDisabled={true} />);

    expect(screen.getByText(REMOVED_NOTICE)).toBeTruthy();

    expect((document.getElementById('rangetestEnabled') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('rangetestSender') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('rangetestSave') as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps the section visible rather than hiding it, so users know nothing broke', () => {
    render(<RangeTestConfigSection {...baseProps} isDisabled={true} />);

    // The title and the settings the user came looking for are still on screen.
    expect(screen.getByText('rangetest_config.title')).toBeTruthy();
    expect(screen.getByText('rangetest_config.enabled')).toBeTruthy();
    expect(screen.getByText('rangetest_config.sender')).toBeTruthy();
  });

  it('never offers a save while the module is removed, even with pending edits', () => {
    // Render with values that differ from the section's own captured baseline by
    // re-rendering with a changed value: the ref baseline is the first render's.
    const { rerender } = render(<RangeTestConfigSection {...baseProps} isDisabled={true} />);
    rerender(<RangeTestConfigSection {...baseProps} sender={999} isDisabled={true} />);

    expect(saveBarCalls.length).toBeGreaterThan(1);
    expect(saveBarCalls.every(c => c.hasChanges === false)).toBe(true);
  });

  it('does offer a save for pending edits when the module IS supported', () => {
    const { rerender } = render(<RangeTestConfigSection {...baseProps} isDisabled={false} />);
    rerender(<RangeTestConfigSection {...baseProps} sender={999} isDisabled={false} />);

    expect(saveBarCalls[saveBarCalls.length - 1].hasChanges).toBe(true);
  });
});
