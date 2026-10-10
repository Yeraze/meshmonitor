/**
 * MapMarkersLayer + LocalMarkerEditorModal (#5686).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MapMarker } from '../../../types/mapMarker';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('react-leaflet', () => ({
  Marker: ({ children, position, icon }: any) => (
    <div data-testid="local-marker" data-pos={JSON.stringify(position)} data-icon-html={icon?.html}>
      {children}
    </div>
  ),
  Popup: ({ children }: any) => <div data-testid="local-marker-popup">{children}</div>,
  Pane: ({ children, name }: any) => <div data-testid={`pane-${name}`}>{children}</div>,
}));

vi.mock('leaflet', () => ({ default: { divIcon: vi.fn((opts: any) => opts) } }));

vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'src-1', name: 'Source One' }, { id: 'src-2', name: 'Two' }] }),
}));

const sample: MapMarker[] = [{
  id: 4, sourceId: 'src-1', label: 'Ridge site', description: 'candidate', latitude: 28.1, longitude: -81.6,
  altitude: 120, icon: 'antenna', color: 'success', createdByUserId: 1, createdAt: 1, updatedAt: 1,
}];
const useMapMarkers = vi.fn((sourceId: string) => ({ markers: sourceId === 'src-1' ? sample : [] }));
vi.mock('../../../hooks/useMapMarkers', () => ({ useMapMarkers: (id: string) => useMapMarkers(id) }));

import { LocalMarkers, PerSourceMapMarkers } from './MapMarkersLayer';
import LocalMarkerEditorModal from '../LocalMarkerEditorModal';

describe('local markers layer (#5686)', () => {
  it('draws an outline glyph with the marker label, and says it is not sent', () => {
    render(<PerSourceMapMarkers source={{ id: 'src-1', name: 'Source One' }} />);
    const m = screen.getByTestId('local-marker');
    expect(JSON.parse(m.dataset.pos!)).toEqual([28.1, -81.6]);
    expect(m.dataset.iconHtml).toContain('<svg');
    expect(m.dataset.iconHtml).toContain('data-local-marker="4"');
    expect(screen.getByText('Ridge site')).toBeInTheDocument();
    expect(screen.getByText('Local marker — not sent to the mesh')).toBeInTheDocument();
    // No edit controls without write.
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('offers edit and delete with write, on a single source', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<LocalMarkers sourceId="src-1" actions={{ canEdit: true, onEdit, onDelete }} />);
    expect(screen.getByTestId('pane-localMarkers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    expect(onEdit).toHaveBeenCalledWith(sample[0]);
    expect(onDelete).toHaveBeenCalledWith(sample[0]);
  });

  it('the unified view reads every source and offers no editing', () => {
    useMapMarkers.mockClear();
    render(<LocalMarkers sourceId={null} actions={{ canEdit: true }} />);
    expect(useMapMarkers.mock.calls.map((c) => c[0]).sort()).toEqual(['src-1', 'src-2']);
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });
});

describe('LocalMarkerEditorModal (#5686)', () => {
  it('needs a label, then saves the clean input', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<LocalMarkerEditorModal isOpen defaultCoords={{ lat: 10.5000001234, lon: 20.25 }} onClose={onClose} onSave={onSave} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Aid station  ' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      label: 'Aid station', description: null, latitude: 10.5, longitude: 20.25, altitude: null, icon: 'pin', color: 'accent',
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a save error and stays open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('This source already has 1000 local markers.'));
    const onClose = vi.fn();
    render(<LocalMarkerEditorModal isOpen initial={sample[0]} onClose={onClose} onSave={onSave} />);
    expect(screen.getByLabelText('Label')).toHaveValue('Ridge site');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1000 local markers');
    expect(onClose).not.toHaveBeenCalled();
  });
});
