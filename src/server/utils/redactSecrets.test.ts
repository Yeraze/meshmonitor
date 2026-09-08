/**
 * Credential redaction on logging paths (#5122 follow-up).
 *
 * MeshMonitor logs decoded protobufs liberally at debug level, and several of
 * those carry credentials in the clear — the node's private and admin keys, the
 * operator's WiFi PSK, MQTT broker passwords, channel PSKs, the Bluetooth PIN.
 * A reporter found them written on every poll cycle during a config sync, so on
 * a mesh where the sync keeps restarting they accumulate. Anyone who then shares
 * a debug log to get help hands those over with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets, safeJson } from './redactSecrets.js';

describe('redactSecrets', () => {
  it('redacts every credential a device config can carry', () => {
    const config = {
      security: { publicKey: 'PUB', privateKey: 'PRIV-SECRET', adminKey: ['ADMIN-SECRET'] },
      network: { wifiSsid: 'HomeNet', wifiPsk: 'hunter2hunter2' },
      bluetooth: { fixedPin: 123456 },
    };
    const out = safeJson(config);

    expect(out).not.toContain('PRIV-SECRET');
    expect(out).not.toContain('ADMIN-SECRET');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('123456');
    expect(out).toContain('[redacted]');
  });

  it('leaves the public key alone — it is public, and key-mismatch debugging needs it', () => {
    const out = safeJson({ security: { publicKey: 'PUBKEY123', privateKey: 'NOPE' } });
    expect(out).toContain('PUBKEY123');
    expect(out).not.toContain('NOPE');
  });

  it('matches snake_case, camelCase and SCREAMING alike', () => {
    // The .proto files say wifi_psk, protobufjs hands us wifiPsk, and both
    // spellings reach log lines depending on which layer produced the object.
    for (const key of ['wifi_psk', 'wifiPsk', 'WIFI_PSK']) {
      expect(safeJson({ [key]: 'topsecret' })).not.toContain('topsecret');
    }
  });

  it('keeps the length, because "is the PSK 16 or 32 bytes" is a real question', () => {
    const out = redactSecrets({ psk: new Uint8Array(32) }) as Record<string, string>;
    expect(out.psk).toBe('[redacted]: 32 bytes');
    const str = redactSecrets({ password: 'abcd' }) as Record<string, string>;
    expect(str.password).toBe('[redacted]: 4 chars');
  });

  it('reaches secrets nested inside arrays — channels are a repeated field', () => {
    const out = safeJson({
      channels: [
        { index: 0, settings: { name: 'Primary', psk: 'CHANNELSECRET' } },
        { index: 1, settings: { name: 'gauntlet', psk: 'OTHERSECRET' } },
      ],
    });
    expect(out).not.toContain('CHANNELSECRET');
    expect(out).not.toContain('OTHERSECRET');
    expect(out).toContain('Primary');
    expect(out).toContain('gauntlet');
  });

  it('preserves everything that is not a secret', () => {
    const cfg = { lora: { region: 'US', hopLimit: 5, usePreset: true }, device: { role: 'CLIENT' } };
    expect(JSON.parse(safeJson(cfg))).toEqual(cfg);
  });

  it('never throws on a logging path', () => {
    // A cycle would otherwise recurse forever, and a throw here would be worse
    // than an unredacted line.
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic.self = cyclic;
    expect(() => safeJson(cyclic)).not.toThrow();
    expect(safeJson(cyclic)).toContain('[circular]');

    expect(() => safeJson(undefined)).not.toThrow();
    expect(() => safeJson(() => {})).not.toThrow();
    expect(safeJson({ big: 1n })).toBe('[unserializable]');
  });

  it('refuses to write a prototype-shaped key from remote input', () => {
    // The object being walked comes off the radio, so its key names are remote
    // input. `out['__proto__'] = ...` on a normal object literal reassigns the
    // prototype instead of adding a property — CodeQL flags this as
    // js/remote-property-injection, and it caught exactly this in review.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "name": "node"}');
    const out = redactSecrets(hostile) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(out.name).toBe('node');
    expect(safeJson(hostile)).toContain('[unsafe key]');
  });

  it('collapses rather than recursing on a pathologically deep object', () => {
    let deep: Record<string, unknown> = { psk: 'SECRET' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const out = safeJson(deep);
    expect(out).toContain('[depth limit]');
    expect(out).not.toContain('SECRET');
  });
});

describe('no raw JSON.stringify on server logging paths (#5122 follow-up)', () => {
  /** Every .ts under src/server, excluding tests. */
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      // The helper's own file documents the rule in prose; it is not a call site.
      if (p.endsWith('redactSecrets.ts')) return [];
      return p.endsWith('.ts') && !p.includes('.test.') ? [p] : [];
    });

  it('routes object logging through safeJson so a new site cannot leak', () => {
    // This is the ratchet. Fixing 56 call sites does nothing for site 57, and
    // the failure mode is silent — a credential in a log nobody inspects. If
    // this fails, use safeJson() instead of JSON.stringify() in the log call.
    const offenders: string[] = [];
    for (const file of sourceFiles('src/server')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('JSON.stringify') || !line.includes('logger.')) return;
        // Object.keys(...) prints field NAMES only — no values, so no secrets.
        if (line.includes('Object.keys')) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
