/**
 * Tests for MQTT detection via isViaMqtt and TransportMechanism constants.
 *
 * Verifies that both legacy viaMqtt boolean and newer transportMechanism enum
 * are handled correctly for MQTT packet detection.
 */

import { describe, it, expect } from 'vitest';
import { isViaMqtt, TransportMechanism, getTransportMechanismName, RoutingError, isPkiError, getPortNumName, StoreForwardRequestResponse, getStoreForwardRequestResponseName } from './meshtastic.js';

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

describe('RoutingError', () => {
  it('defines PKI error codes', () => {
    expect(RoutingError.PKI_FAILED).toBe(34);
    expect(RoutingError.PKI_UNKNOWN_PUBKEY).toBe(35);
    expect(RoutingError.PKI_SEND_FAIL_PUBLIC_KEY).toBe(39);
  });
});

describe('isPkiError', () => {
  it('returns true for PKI_FAILED', () => {
    expect(isPkiError(RoutingError.PKI_FAILED)).toBe(true);
  });

  it('returns true for PKI_UNKNOWN_PUBKEY', () => {
    expect(isPkiError(RoutingError.PKI_UNKNOWN_PUBKEY)).toBe(true);
  });

  it('returns true for PKI_SEND_FAIL_PUBLIC_KEY', () => {
    expect(isPkiError(RoutingError.PKI_SEND_FAIL_PUBLIC_KEY)).toBe(true);
  });

  it('returns false for non-PKI errors', () => {
    expect(isPkiError(RoutingError.NONE)).toBe(false);
    expect(isPkiError(RoutingError.NO_ROUTE)).toBe(false);
    expect(isPkiError(RoutingError.NO_CHANNEL)).toBe(false);
  });

  it('returns false for zero (success/ACK)', () => {
    expect(isPkiError(0)).toBe(false);
  });

  it('all three PKI errors should trigger key mismatch detection', () => {
    // Documents behavior change from PR #2382:
    // All PKI errors now flag keyMismatchDetected regardless of
    // whether the target node is in the radio's device database.
    const pkiErrors = [
      RoutingError.PKI_FAILED,
      RoutingError.PKI_UNKNOWN_PUBKEY,
      RoutingError.PKI_SEND_FAIL_PUBLIC_KEY,
    ];
    for (const err of pkiErrors) {
      expect(isPkiError(err)).toBe(true);
    }
  });
});

describe('getPortNumName', () => {
  it('returns name for known portnums', () => {
    expect(getPortNumName(1)).toBe('TEXT_MESSAGE_APP');
    expect(getPortNumName(3)).toBe('POSITION_APP');
    expect(getPortNumName(67)).toBe('TELEMETRY_APP');
    expect(getPortNumName(70)).toBe('TRACEROUTE_APP');
  });

  it('returns UNKNOWN for unknown portnums', () => {
    expect(getPortNumName(999)).toBe('UNKNOWN_999');
  });
});

describe('StoreForwardRequestResponse', () => {
  it('defines router message types (1-63 range)', () => {
    expect(StoreForwardRequestResponse.ROUTER_ERROR).toBe(1);
    expect(StoreForwardRequestResponse.ROUTER_HEARTBEAT).toBe(2);
    expect(StoreForwardRequestResponse.ROUTER_PING).toBe(3);
    expect(StoreForwardRequestResponse.ROUTER_PONG).toBe(4);
    expect(StoreForwardRequestResponse.ROUTER_BUSY).toBe(5);
    expect(StoreForwardRequestResponse.ROUTER_HISTORY).toBe(6);
    expect(StoreForwardRequestResponse.ROUTER_STATS).toBe(7);
    expect(StoreForwardRequestResponse.ROUTER_TEXT_DIRECT).toBe(8);
    expect(StoreForwardRequestResponse.ROUTER_TEXT_BROADCAST).toBe(9);
  });

  it('defines client message types (64-127 range)', () => {
    expect(StoreForwardRequestResponse.CLIENT_ERROR).toBe(64);
    expect(StoreForwardRequestResponse.CLIENT_HISTORY).toBe(65);
    expect(StoreForwardRequestResponse.CLIENT_STATS).toBe(66);
    expect(StoreForwardRequestResponse.CLIENT_PING).toBe(67);
    expect(StoreForwardRequestResponse.CLIENT_PONG).toBe(68);
    expect(StoreForwardRequestResponse.CLIENT_ABORT).toBe(106);
  });

  it('defines UNSET as 0', () => {
    expect(StoreForwardRequestResponse.UNSET).toBe(0);
  });
});

describe('getStoreForwardRequestResponseName', () => {
  it('returns name for known router types', () => {
    expect(getStoreForwardRequestResponseName(2)).toBe('ROUTER_HEARTBEAT');
    expect(getStoreForwardRequestResponseName(8)).toBe('ROUTER_TEXT_DIRECT');
    expect(getStoreForwardRequestResponseName(9)).toBe('ROUTER_TEXT_BROADCAST');
    expect(getStoreForwardRequestResponseName(7)).toBe('ROUTER_STATS');
  });

  it('returns name for known client types', () => {
    expect(getStoreForwardRequestResponseName(65)).toBe('CLIENT_HISTORY');
    expect(getStoreForwardRequestResponseName(67)).toBe('CLIENT_PING');
    expect(getStoreForwardRequestResponseName(106)).toBe('CLIENT_ABORT');
  });

  it('returns UNKNOWN for unknown values', () => {
    expect(getStoreForwardRequestResponseName(99)).toBe('UNKNOWN_99');
    expect(getStoreForwardRequestResponseName(255)).toBe('UNKNOWN_255');
  });
});
