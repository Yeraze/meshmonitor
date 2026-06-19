/**
 * Tests for the unified SaveBar, focused on grouped ("Save All") behavior.
 *
 * Regression coverage for issue #3552: when multiple sections in a group have
 * unsaved changes, a single Save action must persist ALL of them, not just the
 * active one. Ungrouped sections (Device Configuration) keep per-section saving.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SaveBarProvider, SaveBarGroup } from '../../contexts/SaveBarContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { SaveBar } from './SaveBar';

/** A throwaway section component that registers itself with the SaveBar. */
function Section({
  id,
  name,
  hasChanges,
  onSave,
  onDismiss,
  group,
}: {
  id: string;
  name: string;
  hasChanges: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
  group?: string | null;
}) {
  useSaveBar({
    id,
    sectionName: name,
    hasChanges,
    isSaving: false,
    onSave,
    onDismiss,
    group,
  });
  return null;
}

describe('SaveBar grouped save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves every changed section in the group with one click (issue #3552)', async () => {
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);

    render(
      <SaveBarProvider>
        <SaveBarGroup id="settings">
          <Section id="a" name="Section A" hasChanges onSave={saveA} onDismiss={vi.fn()} />
          <Section id="b" name="Section B" hasChanges onSave={saveB} onDismiss={vi.fn()} />
        </SaveBarGroup>
        <SaveBar />
      </SaveBarProvider>
    );

    const saveButton = await screen.findByText('savebar.save_all');
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(saveA).toHaveBeenCalledTimes(1);
      expect(saveB).toHaveBeenCalledTimes(1);
    });
  });

  it('dismisses every changed section in the group with one click', async () => {
    const dismissA = vi.fn();
    const dismissB = vi.fn();

    render(
      <SaveBarProvider>
        <SaveBarGroup id="settings">
          <Section id="a" name="Section A" hasChanges onSave={vi.fn().mockResolvedValue(undefined)} onDismiss={dismissA} />
          <Section id="b" name="Section B" hasChanges onSave={vi.fn().mockResolvedValue(undefined)} onDismiss={dismissB} />
        </SaveBarGroup>
        <SaveBar />
      </SaveBarProvider>
    );

    const dismissButton = await screen.findByText('common.dismiss');
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(dismissA).toHaveBeenCalledTimes(1);
    expect(dismissB).toHaveBeenCalledTimes(1);
  });

  it('keeps the buttons disabled for the whole batch while saving', async () => {
    // Section A's save is held open so we can observe the in-flight state
    // between sequential saves (regression guard for the double-click window).
    let resolveA: () => void = () => {};
    const saveA = vi.fn(() => new Promise<void>((resolve) => { resolveA = resolve; }));
    const saveB = vi.fn().mockResolvedValue(undefined);

    render(
      <SaveBarProvider>
        <SaveBarGroup id="settings">
          <Section id="a" name="Section A" hasChanges onSave={saveA} onDismiss={vi.fn()} />
          <Section id="b" name="Section B" hasChanges onSave={saveB} onDismiss={vi.fn()} />
        </SaveBarGroup>
        <SaveBar />
      </SaveBarProvider>
    );

    const saveButton = await screen.findByText('savebar.save_all');
    await act(async () => {
      fireEvent.click(saveButton);
    });

    // Mid-batch: A is still saving, B hasn't started, and the button is disabled.
    expect(saveB).not.toHaveBeenCalled();
    const savingButton = screen.getByText('common.saving').closest('button')!;
    expect(savingButton).toBeDisabled();
    expect(screen.getByText('common.dismiss').closest('button')!).toBeDisabled();

    // Let the batch finish.
    await act(async () => {
      resolveA();
    });
    await waitFor(() => expect(saveB).toHaveBeenCalledTimes(1));
  });

  it('continues saving remaining sections if one section save throws', async () => {
    const saveA = vi.fn().mockRejectedValue(new Error('boom'));
    const saveB = vi.fn().mockResolvedValue(undefined);

    render(
      <SaveBarProvider>
        <SaveBarGroup id="settings">
          <Section id="a" name="Section A" hasChanges onSave={saveA} onDismiss={vi.fn()} />
          <Section id="b" name="Section B" hasChanges onSave={saveB} onDismiss={vi.fn()} />
        </SaveBarGroup>
        <SaveBar />
      </SaveBarProvider>
    );

    const saveButton = await screen.findByText('savebar.save_all');
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(saveA).toHaveBeenCalledTimes(1);
      expect(saveB).toHaveBeenCalledTimes(1);
    });
  });

  it('only saves the active section for ungrouped sections (per-section behavior)', async () => {
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);

    render(
      <SaveBarProvider>
        {/* No SaveBarGroup wrapper => ungrouped => per-section save */}
        <Section id="a" name="Device Config A" hasChanges onSave={saveA} onDismiss={vi.fn()} />
        <Section id="b" name="Device Config B" hasChanges onSave={saveB} onDismiss={vi.fn()} />
        <SaveBar />
      </SaveBarProvider>
    );

    // Ungrouped multi-section shows the per-section "Save" label, not "Save All"
    const saveButton = await screen.findByText('common.save');
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      // Only the active section is saved — exactly one of the two, never both.
      // We assert order-independently because the auto-select effect makes the
      // LAST-registered changed section active (last write wins), not the first,
      // so which specific mock fires is an implementation detail.
      expect(saveA.mock.calls.length + saveB.mock.calls.length).toBe(1);
    });
  });

});
