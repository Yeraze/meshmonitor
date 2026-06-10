/**
 * Tests for the remote local_stats telemetry request (issue #3398).
 *
 * The firmware echoes the requested telemetry variant, so to receive LocalStats
 * from a remote node the request payload MUST carry the `local_stats` variant —
 * a generic request returns DeviceMetrics instead. These tests lock that in, plus
 * the parameterized hop limit used to reach multi-hop nodes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { PortNum } from './constants/meshtastic.js';

describe('createTelemetryRequestMessage — local_stats variant (issue #3398)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  const decode = (data: Uint8Array) => {
    const root = getProtobufRoot()!;
    const ToRadio = root.lookupType('meshtastic.ToRadio');
    const Telemetry = root.lookupType('meshtastic.Telemetry');
    const toRadio = ToRadio.decode(data) as any;
    const packet = toRadio.packet;
    const inner = packet.decoded;
    const telemetry = Telemetry.decode(inner.payload) as any;
    return { packet, inner, telemetry };
  };

  it('requests the local_stats variant (not device_metrics)', () => {
    const { data, packetId, requestId } =
      meshtasticProtobufService.createTelemetryRequestMessage(0x1234abcd, 2, 'localStats');

    expect(data.length).toBeGreaterThan(0);
    expect(packetId).toBeGreaterThan(0);
    expect(requestId).toBeGreaterThan(0);

    const { packet, inner, telemetry } = decode(data);
    expect(inner.portnum).toBe(PortNum.TELEMETRY_APP);
    expect(inner.wantResponse).toBe(true);
    // The reply mirrors this variant — must be local_stats, not device_metrics.
    expect(telemetry.variant).toBe('localStats');
    expect(telemetry.localStats).toBeTruthy();
    expect(telemetry.deviceMetrics).toBeFalsy();
    // Unicast to the target node on its channel (bypasses the broadcast role gate).
    expect(packet.to).toBe(0x1234abcd);
    expect(packet.channel).toBe(2);
  });

  it('honors the hopLimit argument for multi-hop targets', () => {
    const { data } = meshtasticProtobufService.createTelemetryRequestMessage(0x1234abcd, 0, 'localStats', 5);
    const { packet } = decode(data);
    expect(packet.hopLimit).toBe(5);
  });

  it('defaults hopLimit to 3 when not provided', () => {
    const { data } = meshtasticProtobufService.createTelemetryRequestMessage(0x1234abcd, 0, 'localStats');
    const { packet } = decode(data);
    expect(packet.hopLimit).toBe(3);
  });

  it('still defaults to device_metrics when no type is given (legacy behavior preserved)', () => {
    const { data } = meshtasticProtobufService.createTelemetryRequestMessage(0x1234abcd, 0);
    const { telemetry } = decode(data);
    expect(telemetry.variant).toBe('deviceMetrics');
  });
});
