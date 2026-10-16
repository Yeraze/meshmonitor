/**
 * Passkey routes against the REAL @simplewebauthn/server (#5841).
 *
 * passkeyRoutes.test.ts mocks the library; this file does not, so a library
 * upgrade that changes its API or wire handling fails here. The browser side
 * is a small software authenticator (P-256 key, "none" attestation) that
 * builds the same bytes a real one sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import passkeyRoutes from './passkeyRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:8080';

vi.mock('../config/environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/environment.js')>();
  return {
    ...actual,
    getEnvironmentConfig: () => ({
      ...actual.getEnvironmentConfig(),
      disableLocalAuth: false,
      webauthnRpId: 'localhost',
      webauthnOrigins: ['http://localhost:8080'],
    }),
  };
});

vi.mock('../middleware/rateLimiters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimiters.js')>();
  return { ...actual, authLimiter: (_req: unknown, _res: unknown, next: () => void) => next() };
});

// ── Minimal CBOR encoder (maps, ints, byte and text strings) ────────────────

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

// ── Software authenticator ──────────────────────────────────────────────────

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest();
const b64url = (b: Buffer) => b.toString('base64url');

class SoftAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;
  userHandle: string | null = null;

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
  }

  private counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.counter, 0);
    return b;
  }

  /** navigator.credentials.create() for options from generateRegistrationOptions(). */
  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }));
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(RP_ID),
      Buffer.from([0x45]), // UP | UV | AT
      this.counterBytes(),
      Buffer.alloc(16), // AAGUID
      credIdLen,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() for options from generateAuthenticationOptions(). */
  authenticate(options: { challenge: string }, opts: { origin?: string } = {}) {
    this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: opts.origin ?? ORIGIN,
      crossOrigin: false,
    }));
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), this.counterBytes()]); // UP | UV
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
    };
  }
}

describe('passkeyRoutes with the real @simplewebauthn/server', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app: Express) => {
        app.use('/api/auth/passkey', passkeyRoutes);
        app.get('/__test__/session', (req, res) => {
          res.json({ userId: req.session.userId ?? null, authProvider: req.session.authProvider ?? null });
        });
      },
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('registers, then signs in, with a software authenticator', async () => {
    const authenticator = new SoftAuthenticator();

    // Register while signed in.
    const owner = await harness.loginAs(harness.limited);
    const regOptions = await owner.post('/api/auth/passkey/register/options').send({});
    expect(regOptions.status).toBe(200);
    expect(regOptions.body.data.rp.id).toBe(RP_ID);

    const reg = await owner
      .post('/api/auth/passkey/register/verify')
      .send({ response: authenticator.register(regOptions.body.data), nickname: 'Soft key' });
    expect(reg.status).toBe(200);
    expect(reg.body.data).toMatchObject({ nickname: 'Soft key', rpId: RP_ID, deviceType: 'singleDevice' });

    // Sign in from a fresh browser.
    const visitor = await harness.loginAs(null);
    const loginOptions = await visitor.post('/api/auth/passkey/login/options').send({});
    expect(loginOptions.status).toBe(200);
    expect(loginOptions.body.data.allowCredentials).toEqual([]);

    const login = await visitor
      .post('/api/auth/passkey/login/verify')
      .send({ response: authenticator.authenticate(loginOptions.body.data) });
    expect(login.status).toBe(200);
    expect(login.body.data.user.id).toBe(harness.limited.id);

    const session = await visitor.get('/__test__/session');
    expect(session.body).toEqual({ userId: harness.limited.id, authProvider: 'local' });

    const [stored] = await harness.db.listPasskeysForUserAsync(harness.limited.id);
    expect(stored.counter).toBe(1);
  });

  it('rejects an assertion made for another origin', async () => {
    const authenticator = new SoftAuthenticator();
    const owner = await harness.loginAs(harness.limited);
    const regOptions = await owner.post('/api/auth/passkey/register/options').send({});
    await owner.post('/api/auth/passkey/register/verify').send({ response: authenticator.register(regOptions.body.data) });

    const visitor = await harness.loginAs(null);
    const loginOptions = await visitor.post('/api/auth/passkey/login/options').send({});
    const login = await visitor
      .post('/api/auth/passkey/login/verify')
      .send({ response: authenticator.authenticate(loginOptions.body.data, { origin: 'https://evil.example' }) });
    expect(login.status).toBe(401);
    expect((await visitor.get('/__test__/session')).body.userId).toBeNull();
  });

  it('rejects a replayed assertion (cloned authenticator)', async () => {
    const authenticator = new SoftAuthenticator();
    const owner = await harness.loginAs(harness.limited);
    const regOptions = await owner.post('/api/auth/passkey/register/options').send({});
    await owner.post('/api/auth/passkey/register/verify').send({ response: authenticator.register(regOptions.body.data) });

    const first = await harness.loginAs(null);
    const opts1 = await first.post('/api/auth/passkey/login/options').send({});
    expect((await first.post('/api/auth/passkey/login/verify').send({ response: authenticator.authenticate(opts1.body.data) })).status).toBe(200);

    // A clone still at counter 0 signs the next challenge with counter 1 again.
    authenticator.counter = 0;
    const second = await harness.loginAs(null);
    const opts2 = await second.post('/api/auth/passkey/login/options').send({});
    const replay = await second
      .post('/api/auth/passkey/login/verify')
      .send({ response: authenticator.authenticate(opts2.body.data) });
    expect(replay.status).toBe(401);
  });
});
