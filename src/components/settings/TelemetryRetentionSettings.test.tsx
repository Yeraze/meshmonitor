/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TelemetryRetentionSettings } from './TelemetryRetentionSettings';
import { TELEMETRY_RETENTION_RANGES } from '../../constants/nodeDisplayDefaults';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

describe('TelemetryRetentionSettings', () => {
  it('renders both inputs with the shared ids, values and ranges', () => {
    render(
      <TelemetryRetentionSettings
        visualizationHours={24}
        favoriteStorageDays={30}
        onVisualizationHoursChange={vi.fn()}
        onFavoriteStorageDaysChange={vi.fn()}
      />,
    );
    const hours = document.getElementById('telemetryVisualizationHours') as HTMLInputElement;
    const days = document.getElementById('favoriteTelemetryStorageDays') as HTMLInputElement;
    expect(hours.value).toBe('24');
    expect(days.value).toBe('30');
    expect(hours.min).toBe(String(TELEMETRY_RETENTION_RANGES.telemetryVisualizationHours.min));
    expect(days.max).toBe(String(TELEMETRY_RETENTION_RANGES.favoriteTelemetryStorageDays.max));
    expect(screen.getByText('settings.telemetry_hours_label')).toBeTruthy();
  });

  it('disables both inputs when read-only', () => {
    render(
      <TelemetryRetentionSettings
        visualizationHours={24}
        favoriteStorageDays={30}
        disabled
        onVisualizationHoursChange={vi.fn()}
        onFavoriteStorageDaysChange={vi.fn()}
      />,
    );
    expect((document.getElementById('telemetryVisualizationHours') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('favoriteTelemetryStorageDays') as HTMLInputElement).disabled).toBe(true);
  });
});
