import { describe, it, expect } from 'vitest';
import { passesNodeFilters, DEFAULT_NODE_FILTERS, isSecurityFlagged } from './nodeAdvancedFilter';
import { mergeNodesAndContacts, toMeshCoreFilterSubject } from './meshcoreNodeRows';

const subj = (securityFlagged?: boolean) => ({
  hasPosition: true, isUnknown: false, isIgnored: false, isFavorite: false, role: 0, channel: 0, securityFlagged,
});

describe('security filter', () => {
  it('without a security filter every subject passes (Meshtastic callers unchanged)', () => {
    expect(passesNodeFilters(subj(true), DEFAULT_NODE_FILTERS)).toBe(true);
    expect(passesNodeFilters(subj(undefined), DEFAULT_NODE_FILTERS)).toBe(true);
  });
  it('flaggedOnly / hideFlagged narrow on securityFlagged', () => {
    expect(passesNodeFilters(subj(true), DEFAULT_NODE_FILTERS, { securityFilter: 'flaggedOnly' })).toBe(true);
    expect(passesNodeFilters(subj(false), DEFAULT_NODE_FILTERS, { securityFilter: 'flaggedOnly' })).toBe(false);
    expect(passesNodeFilters(subj(true), DEFAULT_NODE_FILTERS, { securityFilter: 'hideFlagged' })).toBe(false);
    expect(passesNodeFilters(subj(undefined), DEFAULT_NODE_FILTERS, { securityFilter: 'hideFlagged' })).toBe(true);
  });
  it('isSecurityFlagged matches the Meshtastic key flags', () => {
    expect(isSecurityFlagged({})).toBe(false);
    expect(isSecurityFlagged({ keyIsLowEntropy: true })).toBe(true);
    expect(isSecurityFlagged({ duplicateKeyDetected: true })).toBe(true);
    expect(isSecurityFlagged({ keySecurityIssueDetails: 'x' })).toBe(true);
  });
});

describe('MeshCore flagged rows', () => {
  const k = (c: string) => c.repeat(64);
  const rows = mergeNodesAndContacts([
    { publicKey: k('a'), name: 'Alpha', advType: 1, firstHeard: 1, advertSignatureVerified: true },
    { publicKey: k('b'), name: ' alpha ', advType: 1, firstHeard: 2 },
    { publicKey: k('c'), name: 'Forged', advType: 1, firstHeard: 3, advertSignatureVerified: false },
    { publicKey: k('d'), name: 'Clean', advType: 1, firstHeard: 4, advertSignatureVerified: null },
  ], []);
  const flagged = (c: string) => toMeshCoreFilterSubject(rows.find((r) => r.publicKey === k(c))!).securityFlagged;
  it('flags signature failure and name-reuse suspects only', () => {
    expect(flagged('a')).toBe(false); // the original is not a suspect
    expect(flagged('b')).toBe(true);
    expect(flagged('c')).toBe(true);
    expect(flagged('d')).toBe(false); // null = unchecked, never flagged
  });
});
