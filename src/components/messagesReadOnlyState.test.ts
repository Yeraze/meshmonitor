import { describe, it, expect } from 'vitest';
import { computeMessagesReadOnlyState } from './messagesReadOnlyState';

describe('computeMessagesReadOnlyState (#3831)', () => {
  it('normal messageable node: nothing is read-only', () => {
    expect(computeMessagesReadOnlyState({ mqttReadOnly: false, isUnmessagable: false })).toEqual({
      dmReadOnly: false,
      actionsReadOnly: false,
    });
  });

  it('unmessageable node (not MQTT): DMs hidden but action buttons stay available', () => {
    // The regression #3831 guards against: traceroute / telemetry / nodeinfo /
    // position / neighbor-info / admin-scan are channel-routed, so an
    // unmessageable node still answers them. dmReadOnly is true, actions are NOT.
    expect(computeMessagesReadOnlyState({ mqttReadOnly: false, isUnmessagable: true })).toEqual({
      dmReadOnly: true,
      actionsReadOnly: false,
    });
  });

  it('MQTT-bridge mirror: both DMs and action buttons are read-only', () => {
    expect(computeMessagesReadOnlyState({ mqttReadOnly: true, isUnmessagable: false })).toEqual({
      dmReadOnly: true,
      actionsReadOnly: true,
    });
  });

  it('MQTT mirror AND unmessageable: both read-only', () => {
    expect(computeMessagesReadOnlyState({ mqttReadOnly: true, isUnmessagable: true })).toEqual({
      dmReadOnly: true,
      actionsReadOnly: true,
    });
  });

  it('treats undefined isUnmessagable as messageable (only strict true gates DMs)', () => {
    expect(computeMessagesReadOnlyState({ mqttReadOnly: false, isUnmessagable: undefined })).toEqual({
      dmReadOnly: false,
      actionsReadOnly: false,
    });
  });
});
