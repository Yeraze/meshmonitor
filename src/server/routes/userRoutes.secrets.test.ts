/**
 * userRoutes never send a user's secrets (#5841).
 *
 * Passkey recovery codes are bcrypt hashes, but like the password hash and the
 * MFA fields they must never reach a browser, admin or not. Uses the real
 * harness so the real repository rows (with the new users columns) flow
 * through the real serializers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import userRoutes from './userRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const SECRET_FIELDS = ['passwordHash', 'mfaSecret', 'mfaBackupCodes', 'passkeyRecoveryCodes'];

function expectNoSecrets(user: Record<string, unknown>): void {
  for (const field of SECRET_FIELDS) {
    expect(user, field).not.toHaveProperty(field);
  }
}

describe('userRoutes — secret fields are stripped (#5841)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', userRoutes) });
    await harness.db.auth.updateUser(harness.limited.id, {
      passwordHash: '$2b$10$hash',
      mfaSecret: 'TOTPSECRET',
      mfaBackupCodes: '["$2b$a"]',
    });
    await harness.db.setPasswordLoginDisabledAsync(harness.limited.id, true);
    await harness.db.setPasskeyRecoveryCodesAsync(harness.limited.id, '["$2b$recovery"]');
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET / (list) strips secrets but keeps the passkey-only flag', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    const users = res.body.users as Array<Record<string, unknown>>;
    for (const user of users) expectNoSecrets(user);
    const limited = users.find((u) => u.id === harness.limited.id);
    expect(limited?.passwordLoginDisabled).toBe(true);
  });

  it('GET /:id strips secrets', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.limited.id}`);
    expect(res.status).toBe(200);
    expectNoSecrets(res.body.user);
    expect(res.body.user.passwordLoginDisabled).toBe(true);
  });

  it('PUT /:id strips secrets from the updated user it returns', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${harness.limited.id}`).send({ displayName: 'Limited' });
    expect(res.status).toBe(200);
    expectNoSecrets(res.body.user);
  });
});
