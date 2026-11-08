/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { NodeFilters } from '../../types/ui';
import { AdvancedNodeFilterPopup } from './AdvancedNodeFilterPopup';

vi.mock('react-i18next', () => {
  const t = (_key: string, fallback?: string) => fallback ?? _key;
  return { useTranslation: () => ({ t }) };
});

const filters: NodeFilters = {
  filterMode: 'show',
  showMqtt: false,
  showTelemetry: false,
  showEnvironment: false,
  powerSource: 'both',
  showPosition: false,
  minHops: 0,
  maxHops: 10,
  showPKI: false,
  showRemoteAdmin: false,
  showUnknown: false,
  showIgnored: false,
  showFavoriteLocked: false,
  showHiddenFromMap: false,
  deviceRoles: [],
  channels: [],
};

function renderPopup(onNodeFiltersChange = vi.fn(), nodeFilters: NodeFilters = filters) {
  render(
    <AdvancedNodeFilterPopup
      isOpen
      nodeFilters={nodeFilters}
      securityFilter="all"
      channels={[]}
      onNodeFiltersChange={onNodeFiltersChange}
      onSecurityFilterChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onNodeFiltersChange;
}

describe('AdvancedNodeFilterPopup: Hidden from map (#5952)', () => {
  it('toggles showHiddenFromMap', () => {
    const onChange = renderPopup();
    const box = screen.getByRole('checkbox', { name: /hidden from map/i });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ ...filters, showHiddenFromMap: true });
  });

  it('reset clears showHiddenFromMap', () => {
    const onChange = renderPopup(vi.fn(), { ...filters, showHiddenFromMap: true });
    expect(screen.getByRole('checkbox', { name: /hidden from map/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showHiddenFromMap: false }));
  });
});

describe('AdvancedNodeFilterPopup: configurable (#6259)', () => {
  function renderWith(extra: Record<string, unknown>, onChange = vi.fn(), nodeFilters: NodeFilters = filters) {
    render(
      <AdvancedNodeFilterPopup isOpen nodeFilters={nodeFilters} onNodeFiltersChange={onChange} onClose={vi.fn()} {...extra} />,
    );
    return onChange;
  }

  it('toggles showFavorites', () => {
    const onChange = renderWith({});
    fireEvent.click(screen.getByLabelText('Favorites'));
    expect(onChange).toHaveBeenCalledWith({ ...filters, showFavorites: true });
  });

  it('features hide sections', () => {
    renderWith({ features: { security: false, telemetry: false, powerSource: false, hops: false, channels: false, favorites: false } });
    expect(screen.queryByText('Security')).toBeNull();
    expect(screen.queryByText('Telemetry data')).toBeNull();
    expect(screen.queryByText('Power Source')).toBeNull();
    expect(screen.queryByText('Hops Away')).toBeNull();
    expect(screen.queryByText('Channel')).toBeNull();
    expect(screen.queryByLabelText('Favorites')).toBeNull();
    expect(screen.getByText('Position data')).toBeTruthy();
    expect(screen.getByText('Device Role')).toBeTruthy();
  });

  const roles = [1, 2, 3, 4, 5].map(v => ({ value: v, label: `R${v}` }));

  it('roleOptions drive the checkboxes', () => {
    renderWith({ roleOptions: roles });
    expect(screen.getByLabelText('R1')).toBeTruthy();
    expect(screen.queryByLabelText('Client')).toBeNull();
  });

  it('unchecking with all selected lists the other options', () => {
    const onChange = renderWith({ roleOptions: roles });
    fireEvent.click(screen.getByLabelText('R3'));
    expect(onChange).toHaveBeenCalledWith({ ...filters, deviceRoles: [1, 2, 4, 5] });
  });

  it('re-checking the last role collapses to all', () => {
    const onChange = renderWith({ roleOptions: roles }, vi.fn(), { ...filters, deviceRoles: [1, 2, 4, 5] });
    fireEvent.click(screen.getByLabelText('R3'));
    expect(onChange).toHaveBeenCalledWith({ ...filters, deviceRoles: [] });
  });
});
