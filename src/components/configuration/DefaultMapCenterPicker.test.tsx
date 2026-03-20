// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DefaultMapCenterPicker } from './DefaultMapCenterPicker';

vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: any) => <div data-testid="minimap">{children}</div>,
    TileLayer: () => null,
    useMap: () => ({
        getCenter: () => ({ lat: 40.0, lng: -74.0 }),
        getZoom: () => 10,
        setView: vi.fn(),
    }),
    useMapEvents: (_handlers: any) => ({
        getCenter: () => ({ lat: 40.0, lng: -74.0 }),
        getZoom: () => 10,
    }),
}));

// Mock leaflet CSS import
vi.mock('leaflet/dist/leaflet.css', () => ({}));

describe('DefaultMapCenterPicker', () => {
    it('renders "No default center configured" when lat/lon/zoom are null', () => {
        render(
            <DefaultMapCenterPicker
                lat={null}
                lon={null}
                zoom={null}
                onSave={vi.fn()}
                onClear={vi.fn()}
            />
        );
        expect(screen.getByText('No default center configured')).toBeTruthy();
    });

    it('renders coordinates when configured', () => {
        render(
            <DefaultMapCenterPicker
                lat={40.7128}
                lon={-74.006}
                zoom={12}
                onSave={vi.fn()}
                onClear={vi.fn()}
            />
        );
        expect(screen.getByText(/Default: 40\.7128, -74\.0060 \(zoom 12\)/)).toBeTruthy();
    });

    it('calls onClear when Clear button is clicked', () => {
        const onClear = vi.fn();
        render(
            <DefaultMapCenterPicker
                lat={40.7128}
                lon={-74.006}
                zoom={12}
                onSave={vi.fn()}
                onClear={onClear}
            />
        );
        fireEvent.click(screen.getByText('Clear'));
        expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('calls onSave when "Save as Default" is clicked', () => {
        const onSave = vi.fn();
        render(
            <DefaultMapCenterPicker
                lat={40.7128}
                lon={-74.006}
                zoom={12}
                onSave={onSave}
                onClear={vi.fn()}
            />
        );
        fireEvent.click(screen.getByText('Save as Default'));
        expect(onSave).toHaveBeenCalledTimes(1);
        // Called with numbers
        const [calledLat, calledLon, calledZoom] = onSave.mock.calls[0];
        expect(typeof calledLat).toBe('number');
        expect(typeof calledLon).toBe('number');
        expect(typeof calledZoom).toBe('number');
    });

    it('does not show Clear button when unconfigured', () => {
        render(
            <DefaultMapCenterPicker
                lat={null}
                lon={null}
                zoom={null}
                onSave={vi.fn()}
                onClear={vi.fn()}
            />
        );
        expect(screen.queryByText('Clear')).toBeNull();
    });
});
