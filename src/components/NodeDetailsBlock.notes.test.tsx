/**
 * @vitest-environment jsdom
 *
 * #3921: the Notes textarea follows the stored note as polls bring it in, but
 * never wipes out an edit the user has not saved yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client', distanceUnit: 'km' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const nowS = Math.floor(Date.now() / 1000);
const nodeA: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node A', shortName: 'A', role: 'CLIENT' },
  lastHeard: nowS - 60,
};
const nodeB: DeviceInfo = {
  nodeNum: 456,
  user: { id: '!000001c8', longName: 'Node B', shortName: 'B', role: 'CLIENT' },
  lastHeard: nowS - 60,
};

const save = vi.fn().mockResolvedValue(undefined);
const textarea = () => screen.getByPlaceholderText(/private note/i) as HTMLTextAreaElement;

describe('NodeDetailsBlock notes (#3921)', () => {
  it('shows a note saved elsewhere when a poll brings it in', () => {
    const { rerender } = render(<NodeDetailsBlock node={nodeA} canEditNotes onSaveNotes={save} />);
    expect(textarea().value).toBe('');
    rerender(<NodeDetailsBlock node={{ ...nodeA, notes: 'from the other browser' }} canEditNotes onSaveNotes={save} />);
    expect(textarea().value).toBe('from the other browser');
  });

  it('keeps an unsaved edit when the stored note changes for the same node', () => {
    const { rerender } = render(<NodeDetailsBlock node={{ ...nodeA, notes: 'old' }} canEditNotes onSaveNotes={save} />);
    fireEvent.change(textarea(), { target: { value: 'typing here' } });
    rerender(<NodeDetailsBlock node={{ ...nodeA, notes: 'saved elsewhere' }} canEditNotes onSaveNotes={save} />);
    expect(textarea().value).toBe('typing here');
    // Still dirty against the new stored value, so Save stays enabled.
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('resets the draft when a different node is selected', () => {
    const { rerender } = render(<NodeDetailsBlock node={{ ...nodeA, notes: 'a' }} canEditNotes onSaveNotes={save} />);
    fireEvent.change(textarea(), { target: { value: 'unsaved on A' } });
    rerender(<NodeDetailsBlock node={{ ...nodeB, notes: 'b' }} canEditNotes onSaveNotes={save} />);
    expect(textarea().value).toBe('b');
  });
});
