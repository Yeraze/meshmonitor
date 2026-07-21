/**
 * #4240 (half 2) — node transport classification must be "most-recent wins",
 * not sticky.
 *
 * Reported symptom: a favorited, freshly-heard node with hideFromMap=false was
 * still absent from the Dashboard/Unified map, and stayed absent after a fresh
 * Position + NodeInfo exchange.
 *
 * Cause: this resolver returned `undefined` whenever firmware omitted
 * `transport_mechanism`, which made the caller omit the key from the node
 * upsert, which made `upsertNode` carry the PREVIOUS value forward.
 *
 * Always returning a value is necessary but NOT sufficient: last-wins on its
 * own still thrashes, because a local node with an MQTT uplink receives echoes
 * of its own RF traffic flagged viaMqtt. The visibility fix is the accumulating
 * `transportFlags` bitmask (migration 126, see transportFlags.test.ts); this
 * resolver now feeds `transportBitFor`, deciding which bit gets ORed in.
 */
import { describe, it, expect } from 'vitest';
import { TransportMechanism, resolveRadioPacketTransport } from './meshtastic';

describe('resolveRadioPacketTransport (#4240)', () => {
  it('never returns undefined — an omitted key is what caused the stickiness', () => {
    // This is the regression itself: any shape must yield a stampable value.
    for (const packet of [
      {},
      { transportMechanism: null, viaMqtt: null },
      { transportMechanism: undefined },
      { viaMqtt: false },
      { viaMqtt: true },
    ]) {
      expect(typeof resolveRadioPacketTransport(packet)).toBe('number');
    }
  });

  it('prefers an explicit numeric transport from the wire', () => {
    expect(resolveRadioPacketTransport({ transportMechanism: TransportMechanism.MQTT }))
      .toBe(TransportMechanism.MQTT);
    expect(resolveRadioPacketTransport({ transportMechanism: TransportMechanism.MULTICAST_UDP }))
      .toBe(TransportMechanism.MULTICAST_UDP);
    expect(resolveRadioPacketTransport({ transportMechanism: TransportMechanism.LORA_ALT1 }))
      .toBe(TransportMechanism.LORA_ALT1);
  });

  it('honors an explicit INTERNAL (0) rather than treating it as absent', () => {
    // 0 is falsy; a truthiness check here would misclassify it as LoRa.
    expect(resolveRadioPacketTransport({ transportMechanism: TransportMechanism.INTERNAL }))
      .toBe(TransportMechanism.INTERNAL);
  });

  it('falls back to MQTT when only the legacy viaMqtt flag is set', () => {
    // Keeps MQTT-only nodes hidden by default (#3112) — the fallback must not
    // reclassify them as RF.
    expect(resolveRadioPacketTransport({ viaMqtt: true })).toBe(TransportMechanism.MQTT);
    expect(resolveRadioPacketTransport({ transportMechanism: null, viaMqtt: true }))
      .toBe(TransportMechanism.MQTT);
  });

  it('falls back to LoRa when firmware says nothing and the packet is not viaMqtt', () => {
    // Packets reaching this path came off our own radio, so LoRa is the correct
    // inference — and stamping it is what unsticks a stale MQTT classification.
    expect(resolveRadioPacketTransport({})).toBe(TransportMechanism.LORA);
    expect(resolveRadioPacketTransport({ viaMqtt: false })).toBe(TransportMechanism.LORA);
    expect(resolveRadioPacketTransport({ transportMechanism: null, viaMqtt: null }))
      .toBe(TransportMechanism.LORA);
  });

  it('resolves RF and MQTT packets to distinct values', () => {
    // transportMechanism stays last-wins ("most recently heard via") and is no
    // longer what the map filters on -- transportFlags accumulates instead
    // (migration 126). This still has to distinguish the two, because it feeds
    // transportBitFor, which decides WHICH bit gets ORed in.
    const first = resolveRadioPacketTransport({ viaMqtt: true });
    const second = resolveRadioPacketTransport({ viaMqtt: false });
    expect(first).toBe(TransportMechanism.MQTT);
    expect(second).toBe(TransportMechanism.LORA);
    expect(second).not.toBe(first);
  });

  it('treats an explicit numeric value as authoritative over viaMqtt', () => {
    // Firmware that sets both wins with the enum; viaMqtt is only a fallback.
    expect(resolveRadioPacketTransport({
      transportMechanism: TransportMechanism.LORA,
      viaMqtt: true,
    })).toBe(TransportMechanism.LORA);
  });
});
