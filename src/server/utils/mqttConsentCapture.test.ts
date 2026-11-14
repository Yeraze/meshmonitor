/**
 * #5156: which consent column one received packet stamps.
 */
import { describe, it, expect } from 'vitest';
import { mqttConsentStamp, isMqttDeliveredPacket } from './mqttConsentCapture.js';
import { TX_LORA, TX_MQTT, TX_MULTICAST_UDP, TX_INTERNAL } from '../../utils/nodeTransport.js';

const AT = 1_700_000_000;

describe('mqttConsentStamp', () => {
  it('an MQTT packet with ok_to_mqtt set records true', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_MQTT, bitfield: 1, heardSec: AT }))
      .toEqual({ mqttOkToMqtt: true, mqttOkToMqttAt: AT });
  });

  it('an MQTT packet with ok_to_mqtt clear records false (other bits ignored)', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_MQTT, bitfield: 0b10, heardSec: AT }))
      .toEqual({ mqttOkToMqtt: false, mqttOkToMqttAt: AT });
  });

  it('an MQTT packet with no bitfield records nothing (unknown stays unknown)', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_MQTT, bitfield: null, heardSec: AT })).toEqual({});
    expect(mqttConsentStamp({ transportMechanism: TX_MQTT, bitfield: undefined, heardSec: AT })).toEqual({});
  });

  it('LORA + via_mqtt is an MQTT downlink: records consent, never the RF stamp', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, viaMqtt: true, bitfield: 0, heardSec: AT }))
      .toEqual({ mqttOkToMqtt: false, mqttOkToMqttAt: AT });
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, viaMqtt: true, bitfield: null, heardSec: AT })).toEqual({});
  });

  it('a packet from an MQTT source counts as MQTT whatever it carries', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, arrivedViaMqtt: true, bitfield: 0, heardSec: AT }))
      .toEqual({ mqttOkToMqtt: false, mqttOkToMqttAt: AT });
  });

  it('a LoRa packet with via_mqtt clear stamps direct RF and ignores the bitfield', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, viaMqtt: false, bitfield: 0, heardSec: AT }))
      .toEqual({ rfDirectLastHeard: AT });
  });

  it('INTERNAL / unset mechanism without via_mqtt is RF, as the map classifies it', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_INTERNAL, heardSec: AT })).toEqual({ rfDirectLastHeard: AT });
    expect(mqttConsentStamp({ transportMechanism: undefined, heardSec: AT })).toEqual({ rfDirectLastHeard: AT });
  });

  it('a replayed RF frame is not fresh RF evidence', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, heardSec: AT, replayed: true })).toEqual({});
  });

  it('UDP stamps nothing', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_MULTICAST_UDP, bitfield: 0, heardSec: AT })).toEqual({});
  });

  it('a replay-guarded packet (no heardSec) stamps nothing', () => {
    expect(mqttConsentStamp({ transportMechanism: TX_MQTT, bitfield: 0, heardSec: undefined })).toEqual({});
    expect(mqttConsentStamp({ transportMechanism: TX_LORA, heardSec: undefined })).toEqual({});
  });
});

describe('isMqttDeliveredPacket', () => {
  it('is true for MQTT mechanism, via_mqtt, or an MQTT path', () => {
    expect(isMqttDeliveredPacket({ transportMechanism: TX_MQTT })).toBe(true);
    expect(isMqttDeliveredPacket({ transportMechanism: TX_LORA, viaMqtt: true })).toBe(true);
    expect(isMqttDeliveredPacket({ transportMechanism: TX_LORA, arrivedViaMqtt: true })).toBe(true);
    expect(isMqttDeliveredPacket({ transportMechanism: TX_LORA, viaMqtt: false })).toBe(false);
  });
});
