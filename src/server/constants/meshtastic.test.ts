/**
 * Tests for MQTT detection via isViaMqtt and TransportMechanism constants.
 *
 * Verifies that both legacy viaMqtt boolean and newer transportMechanism enum
 * are handled correctly for MQTT packet detection.
 */

import { describe, it, expect } from 'vitest';
import { isViaMqtt, TransportMechanism, getTransportMechanismName } from './meshtastic.js';

describe('isViaMqtt', () => {
  it('should return true for MQTT transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.MQTT)).toBe(true);
  });

  it('should return false for LORA transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.LORA)).toBe(false);
  });

  it('should return false for INTERNAL transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.INTERNAL)).toBe(false);
  });

  it('should return false for API transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.API)).toBe(false);
  });

  it('should return false for LORA_SECONDARY transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.LORA_SECONDARY)).toBe(false);
  });

  it('should return false for SERIAL transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.SERIAL)).toBe(false);
  });

  it('should return false for MULTICAST_UDP transport mechanism', () => {
    expect(isViaMqtt(TransportMechanism.MULTICAST_UDP)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isViaMqtt(undefined)).toBe(false);
  });

  it('should return false for unknown numeric value', () => {
    expect(isViaMqtt(99)).toBe(false);
  });
});

describe('TransportMechanism', () => {
  it('should have MQTT value of 5', () => {
    expect(TransportMechanism.MQTT).toBe(5);
  });

  it('should have INTERNAL value of 0', () => {
    expect(TransportMechanism.INTERNAL).toBe(0);
  });

  it('should have LORA value of 1', () => {
    expect(TransportMechanism.LORA).toBe(1);
  });
});

describe('getTransportMechanismName', () => {
  it('should return MQTT for MQTT mechanism', () => {
    expect(getTransportMechanismName(TransportMechanism.MQTT)).toBe('MQTT');
  });

  it('should return LORA for LORA mechanism', () => {
    expect(getTransportMechanismName(TransportMechanism.LORA)).toBe('LORA');
  });

  it('should return UNKNOWN for unknown value', () => {
    expect(getTransportMechanismName(99)).toBe('UNKNOWN_99');
  });
});
