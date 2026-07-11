/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapLoadingOverlay } from './MapLoadingOverlay';

describe('MapLoadingOverlay', () => {
  it('renders a status region with the loading label and a spinner', () => {
    render(<MapLoadingOverlay />);
    const overlay = screen.getByTestId('map-loading-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute('role', 'status');
    // Reuses the shared .loading-spinner CSS/animation rather than a new one.
    expect(overlay.querySelector('.loading-spinner')).not.toBeNull();
    expect(screen.getByText('common.loading_indicator')).toBeInTheDocument();
  });
});
