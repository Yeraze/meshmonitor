/**
 * @vitest-environment jsdom
 *
 * #6281: the contact panel shows the persisted clock offset only while the
 * security scan flags the node, and labels a never-set clock.
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
const base: MeshCoreContact = { publicKey: PK, advName: 'N', name: 'N', advType: 1 };
const row = (c: MeshCoreContact) => {
  render(<MeshCoreContactDetailPanel contact={c} publicKey={PK} isCompanion={false} />);
  return screen.queryByTestId('meshcore-clock-offset');
};

describe('MeshCoreContactDetailPanel clock offset row', () => {
  it('is hidden when the node is not flagged', () => {
    expect(row(base)).toBeNull();
  });
  it('shows a behind clock', () => {
    expect(row({ ...base, clockOffsetSeconds: 2 * 3600 + 14 * 60 })?.textContent).toContain('2h 14m behind');
  });
  it('shows an ahead clock', () => {
    expect(row({ ...base, clockOffsetSeconds: -3600 })?.textContent).toContain('1h ahead');
  });
  it('labels a never-set clock', () => {
    expect(row({ ...base, clockOffsetSeconds: 800 * 86400 })?.textContent).toContain('Clock not set');
  });
});
