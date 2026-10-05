import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildSecurityConfigWrite, toCurrentSecurityState } from './securityConfigWrite.js';

const PUB = Buffer.alloc(32, 0x11).toString('base64');
const PRIV = Buffer.alloc(32, 0x22).toString('base64');
const client = { adminKeys: ['k'], isManaged: true, serialEnabled: false };

describe('toCurrentSecurityState', () => {
  it('turns key bytes into base64 and keeps a set policy', () => {
    expect(toCurrentSecurityState({
      publicKey: Buffer.from(PUB, 'base64'),
      privateKey: Buffer.from(PRIV, 'base64'),
      packetSignaturePolicy: 2,
    })).toEqual({ publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 2 });
  });

  it('reads empty or missing keys as null', () => {
    expect(toCurrentSecurityState({ publicKey: new Uint8Array(0) })).toEqual({
      publicKey: null, privateKey: null, packetSignaturePolicy: undefined,
    });
    expect(toCurrentSecurityState(null).privateKey).toBeNull();
  });

  it.each([0, undefined, null, -1, 1.5, '2', NaN])('reads policy %s as "nothing to write"', (value) => {
    expect(toCurrentSecurityState({ packetSignaturePolicy: value }).packetSignaturePolicy).toBeUndefined();
  });

  it('passes through a policy value newer than this code knows', () => {
    expect(toCurrentSecurityState({ packetSignaturePolicy: 3 }).packetSignaturePolicy).toBe(3);
  });
});

describe('buildSecurityConfigWrite', () => {
  it.each([1, 2])('carries the node policy %i for a local and a remote write', (policy) => {
    const current = { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: policy };
    for (const allowClientKeys of [true, false]) {
      expect(buildSecurityConfigWrite(client, current, { allowClientKeys })).toEqual({
        ...client, publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: policy,
      });
    }
  });

  it('leaves the policy key off when the node has none', () => {
    const write = buildSecurityConfigWrite(client, { publicKey: PUB, privateKey: PRIV }, { allowClientKeys: true });
    expect('packetSignaturePolicy' in write).toBe(false);
  });

  it('client value wins when sent, whichever way it points (#5612)', () => {
    const down = buildSecurityConfigWrite(
      { ...client, packetSignaturePolicy: 0 },
      { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 2 },
      { allowClientKeys: true },
    );
    // An explicit COMPATIBLE is a choice: field 9 stays off the wire, which
    // firmware reads as COMPATIBLE. It must not fall back to the node's STRICT.
    expect('packetSignaturePolicy' in down).toBe(false);

    const up = buildSecurityConfigWrite(
      { ...client, packetSignaturePolicy: 2 },
      { publicKey: PUB, privateKey: PRIV },
      { allowClientKeys: false },
    );
    expect(up.packetSignaturePolicy).toBe(2);

    const sideways = buildSecurityConfigWrite(
      { ...client, packetSignaturePolicy: 1 },
      { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 2 },
      { allowClientKeys: false },
    );
    expect(sideways.packetSignaturePolicy).toBe(1);
  });

  it('keeps the node policy when the client sends none', () => {
    const write = buildSecurityConfigWrite(
      client,
      { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 2 },
      { allowClientKeys: false },
    );
    expect(write.packetSignaturePolicy).toBe(2);
  });

  it.each([[3], [-1], ['2'], [null], [1.5]])('keeps the node policy when the client value %j is not one we know', (bad) => {
    const write = buildSecurityConfigWrite(
      { ...client, packetSignaturePolicy: bad },
      { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 1 },
      { allowClientKeys: true },
    );
    expect(write.packetSignaturePolicy).toBe(1);
  });

  it('remote: the node keys win over anything the client sent', () => {
    const write = buildSecurityConfigWrite(
      { ...client, publicKey: 'CLIENTPUB', privateKey: 'CLIENTPRIV' },
      { publicKey: PUB, privateKey: PRIV },
      { allowClientKeys: false },
    );
    expect(write.publicKey).toBe(PUB);
    expect(write.privateKey).toBe(PRIV);
  });

  it('local: a new private key is sent with its derived public key, prefix stripped', () => {
    const kp = generateKeyPairSync('x25519');
    const priv = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
    const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const write = buildSecurityConfigWrite(
      { ...client, privateKey: `base64:${priv}` },
      { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 1 },
      { allowClientKeys: true },
    );
    expect(write).toMatchObject({ privateKey: priv, publicKey: pub, packetSignaturePolicy: 1 });
  });

  it('local: re-sending the current key keeps the pair', () => {
    const write = buildSecurityConfigWrite(
      { ...client, privateKey: `base64:${PRIV}` },
      { publicKey: PUB, privateKey: PRIV },
      { allowClientKeys: true },
    );
    expect(write).toMatchObject({ privateKey: PRIV, publicKey: PUB });
  });

  it('local: a node with no keys yet gets no key fields', () => {
    const write = buildSecurityConfigWrite(client, { publicKey: null, privateKey: null }, { allowClientKeys: true });
    expect('publicKey' in write).toBe(false);
    expect('privateKey' in write).toBe(false);
  });

  it('does not mutate the request body', () => {
    const body = { ...client, packetSignaturePolicy: 0 };
    buildSecurityConfigWrite(body, { publicKey: PUB, privateKey: PRIV, packetSignaturePolicy: 2 }, { allowClientKeys: true });
    expect(body).toEqual({ ...client, packetSignaturePolicy: 0 });
  });
});
