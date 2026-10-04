import { describe, it, expect } from 'vitest';
import { redactBrokerUrl } from './brokerUrl.js';

describe('redactBrokerUrl (#5596)', () => {
  it('leaves a URL with no credentials alone', () => {
    expect(redactBrokerUrl('mqtt://broker.test:1883')).toBe('mqtt://broker.test:1883');
    expect(redactBrokerUrl('wss://broker.test:443/mqtt')).toBe('wss://broker.test:443/mqtt');
  });

  it('strips user and password', () => {
    expect(redactBrokerUrl('mqtts://bob:secret@broker.test:8883')).toBe('mqtts://***@broker.test:8883');
    expect(redactBrokerUrl('mqtt://bob@broker.test')).toBe('mqtt://***@broker.test');
  });

  it('strips a password that itself holds an @', () => {
    expect(redactBrokerUrl('mqtt://user:pa@ss@corp.example:1883')).toBe('mqtt://***@corp.example:1883');
  });

  it('does not treat an @ in the path as credentials', () => {
    expect(redactBrokerUrl('wss://broker.test/topic@x')).toBe('wss://broker.test/topic@x');
  });
});
