import { describe, it, expect } from 'vitest';
import { stripUserSecrets, USER_SECRET_FIELDS } from './userSecrets.js';

describe('stripUserSecrets', () => {
  it('drops every secret field, passkey recovery codes included (#5841)', () => {
    const user = {
      id: 1,
      username: 'alice',
      passwordHash: '$2b$hash',
      mfaSecret: 'TOTPSECRET',
      mfaBackupCodes: '["$2b$a"]',
      passkeyRecoveryCodes: '["$2b$b"]',
      passwordLoginDisabled: true,
      isAdmin: false,
    };
    const safe = stripUserSecrets(user);
    for (const field of USER_SECRET_FIELDS) {
      expect(safe).not.toHaveProperty(field);
    }
    expect(safe).toEqual({ id: 1, username: 'alice', passwordLoginDisabled: true, isAdmin: false });
    // The input is not changed.
    expect(user.passkeyRecoveryCodes).toBe('["$2b$b"]');
  });
});
