/**
 * Drop every secret field from a user object before it leaves the server.
 *
 * One list, so a new secret column (#5841 added `passkeyRecoveryCodes`) only
 * needs adding here, not at each route that sends a user.
 */
export const USER_SECRET_FIELDS = [
  'passwordHash',
  'mfaSecret',
  'mfaBackupCodes',
  'passkeyRecoveryCodes',
] as const;

export type UserSecretField = (typeof USER_SECRET_FIELDS)[number];

export function stripUserSecrets<T extends object>(user: T): Omit<T, UserSecretField> {
  const copy = { ...user } as Record<string, unknown>;
  for (const field of USER_SECRET_FIELDS) {
    delete copy[field];
  }
  return copy as Omit<T, UserSecretField>;
}
