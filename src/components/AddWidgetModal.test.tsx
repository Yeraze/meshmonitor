/**
 * @vitest-environment jsdom
 *
 * AddWidgetModal filters its options to the data source's supported widgets (#6263 S6).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

import AddWidgetModal, { type WidgetType } from './AddWidgetModal';
import { meshcoreDashboardSource, meshtasticDashboardSource, reticulumDashboardSource } from './Dashboard/dataSources';

const renderModal = (supported?: ReadonlySet<WidgetType>) =>
  render(<AddWidgetModal isOpen onClose={vi.fn()} onAddWidget={vi.fn()} supported={supported} />);

describe('AddWidgetModal', () => {
  it('offers every widget when no filter is given', () => {
    renderModal();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBe(7); // 6 widgets + "more"
  });

  it('offers only supported widgets', () => {
    renderModal(new Set<WidgetType>(['traceroute', 'nodeStatus']));
    expect(screen.getByText('dashboard.widget.traceroute.title')).toBeTruthy();
    expect(screen.getByText('dashboard.widget.node_status.title')).toBeTruthy();
    expect(screen.queryByText('dashboard.widget.hop_distribution.title')).toBeNull();
    expect(screen.queryByText('dashboard.widget.live_mesh_activity.title')).toBeNull();
  });

  it('shows all six for the MeshCore and Meshtastic sources', () => {
    for (const src of [meshcoreDashboardSource, meshtasticDashboardSource]) {
      const { unmount } = renderModal(src.widgets.supported);
      expect(screen.getAllByRole('heading', { level: 3 }).length).toBe(7);
      unmount();
    }
  });

  it('Reticulum supports none', () => {
    expect(reticulumDashboardSource.widgets.supported.size).toBe(0);
  });
});
