/**
 * #4711 — the run log has to show what actually triggered a rule. These pin the
 * field-driven summarizer against the real `ctx.fields` bags every trigger
 * builder in `src/server/services/automation/triggerContext.ts` produces.
 */
import { describe, it, expect } from 'vitest';
import { summarizeTriggerEvent, summaryLine, parseJsonColumn } from './eventSummary';

describe('summarizeTriggerEvent', () => {
  it('pulls node, channel and text out of a Meshtastic message payload', () => {
    const s = summarizeTriggerEvent({
      from: 1128074276, fromId: '!433d1ba4', fromName: 'Base Station',
      to: 4294967295, text: 'ping', channel: 2, channelName: 'gauntlet',
      isDM: false, isChannel: true, protocol: 'meshtastic',
    });
    expect(s.node).toBe('Base Station');
    expect(s.channel).toBe('gauntlet');
    expect(s.text).toBe('ping');
  });

  it('handles a real captured MQTT run payload, which carries no channelName', () => {
    // Copied verbatim from `GET /api/automations/:id/runs` on a live instance:
    // an MQTT-sourced Auto-Ack run. `channelName` is absent (the channel is an
    // MQTT channel-database identity), so the index has to carry the label.
    const s = summarizeTriggerEvent({
      from: 2956827772, fromId: '!b03d9c7c', fromName: 'KA1KG Node 1',
      to: 4294967295, toId: '!ffffffff', text: 'Test', channel: 102,
      senderLabel: 'KA1KG Node 1', portnum: 1, packetId: 1501735753,
      viaMqttSource: true, zeroHop: 0, isDM: false, isChannel: true, isBroadcast: true,
      snr: 0, viaMqtt: true, protocol: 'meshtastic', protocolShort: 'MT',
      sourceId: 'feb9a2cc-dbb3-4bb2-9b9f-cb038c74421a', timestamp: 1786651269849,
    });
    expect(s).toEqual({ node: 'KA1KG Node 1', channel: 'ch 102', text: 'Test', detail: undefined });
  });

  it('falls back to the node id, then the raw nodeNum, when there is no name', () => {
    expect(summarizeTriggerEvent({ from: 123, fromId: '!0000007b' }).node).toBe('!0000007b');
    expect(summarizeTriggerEvent({ from: 123 }).node).toBe('123');
    expect(summarizeTriggerEvent({ nodeNum: 456 }).node).toBe('node 456');
  });

  it('labels an unnamed channel by index, and a DM as a DM', () => {
    expect(summarizeTriggerEvent({ channel: 0, isDM: false }).channel).toBe('ch 0');
    expect(summarizeTriggerEvent({ channel: 0, isDM: true }).channel).toBe('DM');
    // A MeshCore DM carries no channel index at all.
    expect(summarizeTriggerEvent({ isDM: true }).channel).toBe('DM');
    expect(summarizeTriggerEvent({ text: 'hi' }).channel).toBeUndefined();
  });

  it('elides a MeshCore pubkey sender rather than letting it run on', () => {
    const pubkey = 'a'.repeat(64);
    const s = summarizeTriggerEvent({ from: pubkey, fromId: pubkey, text: 'hi', protocol: 'meshcore' });
    expect(s.node).toHaveLength(24);
    expect(s.node?.endsWith('…')).toBe(true);
  });

  it('prefers a MeshCore sender name over the pubkey', () => {
    const s = summarizeTriggerEvent({
      from: 'b'.repeat(64), fromId: 'b'.repeat(64), fromName: 'Kokoshell',
      text: 'hello', channel: 1, channelName: 'public', isChannel: true, protocol: 'meshcore',
    });
    expect(s.node).toBe('Kokoshell');
    expect(s.channel).toBe('public');
  });

  it('summarizes a telemetry reading with its unit', () => {
    expect(summarizeTriggerEvent({ nodeNum: 7, telemetryType: 'batteryLevel', value: 42, unit: '%' }).detail)
      .toBe('batteryLevel = 42 %');
    expect(summarizeTriggerEvent({ nodeNum: 7, telemetryType: 'voltage', value: 3.9 }).detail)
      .toBe('voltage = 3.9');
  });

  it('summarizes geofence, system, leftHome, becameMobile and node-change payloads', () => {
    expect(summarizeTriggerEvent({ event: 'enter', nodeNum: 9, distanceKm: 1.2 }).detail).toBe('enter');
    expect(summarizeTriggerEvent({ event: 'source-disconnected', reason: 'socket closed' }).detail)
      .toBe('source-disconnected — socket closed');
    expect(summarizeTriggerEvent({ nodeNum: 9, distanceMeters: 1234.6, thresholdMeters: 500 }).detail)
      .toBe('left home · 1235m');
    expect(summarizeTriggerEvent({ nodeNum: 9, previousMobile: 0, mobile: 1 }).detail).toBe('became mobile');
    expect(summarizeTriggerEvent({ nodeNum: 9, changed: ['longName', 'hwModel'] }).detail)
      .toBe('changed: longName, hwModel');
  });

  it('keys each detail on the field unique to its builder, not a reusable one', () => {
    // Review feedback on #4716: `value` and `mobile` are generic enough that a
    // future builder could plausibly carry them. Only `telemetryType` may mean
    // telemetry, and only `previousMobile` may mean a mobility flip — otherwise a
    // payload that merely happens to have `value`/`mobile` gets mislabelled.
    expect(summarizeTriggerEvent({ nodeNum: 1, value: 42 }).detail).toBeUndefined();
    expect(summarizeTriggerEvent({ nodeNum: 1, mobile: 1 }).detail).toBeUndefined();
    // …and the genuine articles still resolve.
    expect(summarizeTriggerEvent({ nodeNum: 1, telemetryType: 'ch1Voltage', value: 12 }).detail)
      .toBe('ch1Voltage = 12');
    expect(summarizeTriggerEvent({ nodeNum: 1, previousMobile: 0, mobile: 1 }).detail)
      .toBe('became mobile');
  });

  it('reads a MeshBeacon body as the text, and its offer as the detail', () => {
    const s = summarizeTriggerEvent({ nodeNum: 11, message: 'join us', offerChannelName: 'RegionMesh', hasOffer: true });
    expect(s.text).toBe('join us');
    expect(s.node).toBe('node 11');
    const offerOnly = summarizeTriggerEvent({ nodeNum: 11, offerChannelName: 'RegionMesh', hasOffer: true });
    expect(offerOnly.detail).toBe('offers RegionMesh');
  });

  it('returns an empty summary for a payload with nothing human-facing', () => {
    // trigger.schedule — a cron tick carries no mesh payload at all.
    expect(summarizeTriggerEvent({ sourceId: 'src-1', timestamp: 1 })).toEqual({
      node: undefined, channel: undefined, text: undefined, detail: undefined,
    });
    expect(summarizeTriggerEvent(null)).toEqual({});
    expect(summarizeTriggerEvent(undefined)).toEqual({});
  });

  it('ignores blank strings rather than rendering empty facts', () => {
    const s = summarizeTriggerEvent({ fromName: '   ', fromId: '!abc', text: '', channelName: '' });
    expect(s.node).toBe('!abc');
    expect(s.text).toBeUndefined();
    expect(s.channel).toBeUndefined();
  });
});

describe('summaryLine', () => {
  it('joins the parts into the live-trace one-liner', () => {
    const line = summaryLine(summarizeTriggerEvent({
      from: 123, fromName: 'Alpha', channel: 2, channelName: 'gauntlet', text: 'ping', isDM: false,
    }));
    expect(line).toBe('from Alpha · gauntlet · "ping"');
  });

  it('falls back to a placeholder when there is nothing to say', () => {
    expect(summaryLine({})).toBe('(no event payload)');
  });
});

describe('parseJsonColumn', () => {
  it('parses valid JSON and returns null for absent or malformed input', () => {
    expect(parseJsonColumn<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonColumn('not json')).toBeNull();
    expect(parseJsonColumn('null')).toBeNull();
    expect(parseJsonColumn(null)).toBeNull();
    expect(parseJsonColumn('')).toBeNull();
  });
});
