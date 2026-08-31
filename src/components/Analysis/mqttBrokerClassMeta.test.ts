import { describe, it, expect } from 'vitest';
import { brokerClassMeta, type BrokerAddressClass } from './mqttViolationTypes';

describe('brokerClassMeta', () => {
  it('private -> ok tone, "Expected — private broker"', () => {
    const meta = brokerClassMeta('private');
    expect(meta.tone).toBe('ok');
    expect(meta.labelFallback).toBe('Expected — private broker');
    expect(meta.labelKey).toBe('analysis.mqtt_violations.broker_private');
    expect(meta.descriptionFallback.length).toBeGreaterThan(0);
  });

  it('public -> warn tone, "Confirmed — public broker"', () => {
    const meta = brokerClassMeta('public');
    expect(meta.tone).toBe('warn');
    expect(meta.labelFallback).toBe('Confirmed — public broker');
    expect(meta.labelKey).toBe('analysis.mqtt_violations.broker_public');
  });

  it('unknown -> neutral tone, "Unverified — hostname broker"', () => {
    const meta = brokerClassMeta('unknown');
    expect(meta.tone).toBe('neutral');
    expect(meta.labelFallback).toBe('Unverified — hostname broker');
    expect(meta.labelKey).toBe('analysis.mqtt_violations.broker_unknown');
  });

  it('every class has a distinct labelKey/descriptionKey pair', () => {
    const classes: BrokerAddressClass[] = ['private', 'public', 'unknown'];
    const labelKeys = new Set(classes.map((c) => brokerClassMeta(c).labelKey));
    const descKeys = new Set(classes.map((c) => brokerClassMeta(c).descriptionKey));
    expect(labelKeys.size).toBe(3);
    expect(descKeys.size).toBe(3);
  });
});
