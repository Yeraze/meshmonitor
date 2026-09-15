/**
 * MESHTASTIC_NODE_IP resolution (#5237).
 *
 * `meshtasticNodeIpProvided` gates two places that would otherwise dial the
 * placeholder 192.168.1.100 on an install that never named a node:
 *   - the fresh-install source auto-create in bootstrapSources.ts (#5237);
 *   - the OTA firmware wizard's guard in firmwareUpdateRoutes.ts (#2981).
 *
 * So the flag must mean "the operator named a host", not merely "the variable
 * exists in the environment" — `MESHTASTIC_NODE_IP=` with nothing after it is
 * a normal docker-compose shape and must read as unset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

describe('MESHTASTIC_NODE_IP environment resolution (#5237)', () => {
  const original = process.env.MESHTASTIC_NODE_IP;

  afterEach(() => {
    if (original !== undefined) {
      process.env.MESHTASTIC_NODE_IP = original;
    } else {
      delete process.env.MESHTASTIC_NODE_IP;
    }
    resetEnvironmentConfig();
  });

  it('reports the placeholder as NOT provided when the variable is absent', () => {
    delete process.env.MESHTASTIC_NODE_IP;
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.meshtasticNodeIp).toBe('192.168.1.100');
    expect(config.meshtasticNodeIpProvided).toBe(false);
  });

  it('reports an explicitly set host as provided', () => {
    process.env.MESHTASTIC_NODE_IP = '10.0.0.7';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.meshtasticNodeIp).toBe('10.0.0.7');
    expect(config.meshtasticNodeIpProvided).toBe(true);
  });

  it('treats an empty MESHTASTIC_NODE_IP= as NOT provided', () => {
    // `- MESHTASTIC_NODE_IP=` in a compose file. The variable exists, so a bare
    // `!== undefined` check would call the placeholder user-supplied and let
    // both consumers dial it — the exact regression #5237 fixed.
    process.env.MESHTASTIC_NODE_IP = '';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.meshtasticNodeIp).toBe('192.168.1.100');
    expect(config.meshtasticNodeIpProvided).toBe(false);
  });

  it('treats a whitespace-only MESHTASTIC_NODE_IP as NOT provided', () => {
    process.env.MESHTASTIC_NODE_IP = '   ';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.meshtasticNodeIp).toBe('192.168.1.100');
    expect(config.meshtasticNodeIpProvided).toBe(false);
  });

  it('trims surrounding whitespace off a real host', () => {
    process.env.MESHTASTIC_NODE_IP = '  10.0.0.8  ';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.meshtasticNodeIp).toBe('10.0.0.8');
    expect(config.meshtasticNodeIpProvided).toBe(true);
  });
});
