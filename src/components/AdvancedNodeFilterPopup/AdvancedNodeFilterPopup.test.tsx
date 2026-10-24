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
