// @vitest-environment jsdom
/**
 * Coverage for the MeshBeacon BroadcastTargetsEditor (issue #4802). The editor
 * owns no state — it renders the passed array and reports edits through onChange
 * — so these assert the array transforms for add / remove / edit-each-field.
 *
 * The test i18n mock returns the translation KEY (see src/test/setup.ts), so we
 * query controls by their `meshbeacon_config.*` keys rather than English text.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BroadcastTargetsEditor from './BroadcastTargetsEditor';
import type { BroadcastTarget } from '../admin-commands/useAdminCommandsState';

function renderEditor(targets: BroadcastTarget[]) {
  const onChange = vi.fn();
  render(<BroadcastTargetsEditor targets={targets} onChange={onChange} disabled={false} />);
  return onChange;
}

describe('BroadcastTargetsEditor', () => {
  it('adds a neutral target when "Add target" is clicked', () => {
    const onChange = renderEditor([]);
    fireEvent.click(screen.getByText('meshbeacon_config.target_add'));
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 0, channelIndex: null }]);
  });

  it('removes the target at the clicked index', () => {
    const onChange = renderEditor([
      { preset: 6, region: 1, channelIndex: 0 },
      { preset: null, region: 2, channelIndex: null },
    ]);
    const removeButtons = screen.getAllByText('meshbeacon_config.target_remove');
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 2, channelIndex: null }]);
  });

  it('edits a target preset, mapping the empty option back to null', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const presetSelect = screen.getByLabelText('meshbeacon_config.target_preset');
    fireEvent.change(presetSelect, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: null, region: 1, channelIndex: 0 }]);
  });

  it('edits a target region', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const regionSelect = screen.getByLabelText('meshbeacon_config.target_region');
    fireEvent.change(regionSelect, { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 3, channelIndex: 0 }]);
  });

  it('edits a target channel index, mapping empty back to null', () => {
    const onChange = renderEditor([{ preset: 6, region: 1, channelIndex: 0 }]);
    const channelInput = screen.getByLabelText('meshbeacon_config.target_channel_index');
    fireEvent.change(channelInput, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 1, channelIndex: 2 }]);

    fireEvent.change(channelInput, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith([{ preset: 6, region: 1, channelIndex: null }]);
  });

  it('renders one row per target', () => {
    renderEditor([
      { preset: 6, region: 1, channelIndex: 0 },
      { preset: null, region: 2, channelIndex: null },
      { preset: 0, region: 0, channelIndex: 1 },
    ]);
    expect(screen.getAllByText('meshbeacon_config.target_remove')).toHaveLength(3);
  });
});
