/**
 * @vitest-environment jsdom
 *
 * #6370: the Nodes view Import dialog accepts a MeshCore One contact-share
 * token alongside the signed-advert hex, with the full-list confirm in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('./MeshCoreMap', () => ({ MeshCoreMap: () => <div data-testid="mc-map" /> }));
const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test Source', sourceType: 'meshcore' }),
}));
vi.mock('../../hooks/useNodeDisplaySettings', () => ({
  useNodeDisplaySettings: () => ({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 }),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';

const KEY = '12'.repeat(32);
const TOKEN = `<${KEY.toUpperCase()}:1:Alice: mobile>`;

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  return screen.getByRole('dialog') as HTMLElement;
}

describe('MeshCoreNodesView Import dialog — contact tokens (#6370)', () => {
  beforeEach(() => {
    localStorage.clear();
    showToast.mockReset();
  });

  it('sends a token to the token importer, not the advert importer', async () => {
    const onImportContact = vi.fn();
    const onImportContactToken = vi.fn(async () => ({ success: true, status: 'added', evicted: [] }));
    render(
      <MeshCoreNodesView
        nodes={[]}
        contacts={[]}
        onImportContact={onImportContact}
        onImportContactToken={onImportContactToken}
      />,
    );
    const dialog = openDialog();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: `  ${TOKEN}\n` } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import' }).at(-1)!);
    await waitFor(() => expect(onImportContactToken).toHaveBeenCalledWith(TOKEN, false));
    expect(onImportContact).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('Imported to the radio.', 'success');
  });

  it('confirms a full radio list in place, then retries with confirmFull', async () => {
    const onImportContactToken = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'CONTACT_TABLE_FULL_CONFIRM', error: 'List is full (50/50).' })
      .mockResolvedValueOnce({ success: true, status: 'added', evicted: [] });
    render(<MeshCoreNodesView nodes={[]} contacts={[]} onImportContactToken={onImportContactToken} />);
    const dialog = openDialog();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: TOKEN } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import' }).at(-1)!);
    await waitFor(() => expect(screen.getByText(/List is full \(50\/50\)/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Import anyway' }));
    await waitFor(() => expect(onImportContactToken).toHaveBeenLastCalledWith(TOKEN, true));
  });

  it('still imports advert hex through the advert importer', async () => {
    const onImportContact = vi.fn(async () => true);
    const onImportContactToken = vi.fn();
    render(
      <MeshCoreNodesView
        nodes={[]}
        contacts={[]}
        onImportContact={onImportContact}
        onImportContactToken={onImportContactToken}
      />,
    );
    const dialog = openDialog();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'meshcore://0a0b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import' }).at(-1)!);
    await waitFor(() => expect(onImportContact).toHaveBeenCalledWith([10, 11]));
    expect(onImportContactToken).not.toHaveBeenCalled();
  });

  it('says why a malformed token fails (type 4 is not a contact)', async () => {
    render(<MeshCoreNodesView nodes={[]} contacts={[]} onImportContact={vi.fn()} onImportContactToken={vi.fn()} />);
    const dialog = openDialog();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: `<${KEY}:4:Sensor>` } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import' }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not a contact/);
  });
});
