/**
 * @vitest-environment jsdom
 *
 * P7a (#6254): the contact panel's Advert signature row is tri-state.
 * Unchecked (null / unset, e.g. every Companion contact) reads "Not checked",
 * never "Failed".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 's', sourceName: 'S' }),
}));
vi.mock('./MeshCoreRemoteConsole', () => ({ MeshCoreRemoteConsole: () => null }));

const PK = 'ab'.repeat(32);
const base: MeshCoreContact = { publicKey: PK, advName: 'N', name: 'N', advType: 2 };

function valueFor(contact: MeshCoreContact): string {
  render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} isCompanion={false} />);
  return screen.getByTestId('meshcore-advert-signature').textContent ?? '';
}

describe('MeshCoreContactDetailPanel advert signature row', () => {
  it('Verified when true', () => {
    expect(valueFor({ ...base, advertSignatureVerified: true })).toContain('Verified');
  });
  it('Failed when false', () => {
    expect(valueFor({ ...base, advertSignatureVerified: false })).toContain('Failed');
  });
  it('Not checked when null', () => {
    const v = valueFor({ ...base, advertSignatureVerified: null });
    expect(v).toContain('Not checked');
    expect(v).not.toContain('Failed');
  });
  it('Not checked when unset', () => {
    expect(valueFor(base)).toContain('Not checked');
  });
});
