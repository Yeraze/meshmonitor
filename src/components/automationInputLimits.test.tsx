/**
 * @vitest-environment jsdom
 *
 * Number inputs on the Automation page must declare a real `max`.
 *
 * With `max` absent, Chrome exposes the spinbutton with `aria-valuemax="0"`, so
 * the Geofence Cooldown field read as a 0-to-0 range while it took any value.
 * These tests pin the Geofence inputs' bounds and clamping, then sweep every
 * number input in the Automation sections so a new one cannot ship without a
 * `max`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import {
  clampInt,
  GEOFENCE_COOLDOWN_MINUTES_MAX,
  GEOFENCE_INTERVAL_MINUTES_MAX,
} from './automationInputLimits';

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => undefined }));
vi.mock('../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ scripts: [] }) } }));
vi.mock('./GeofenceMapEditor', () => ({ default: () => <div data-testid="geofence-map-editor" /> }));
vi.mock('./GeofenceNodeSelector', () => ({ default: () => <div data-testid="geofence-node-selector" /> }));

function renderGeofence() {
  return render(
    <GeofenceTriggersSection triggers={[]} channels={[]} nodes={[]} baseUrl="" onTriggersChange={vi.fn()} />,
  );
}

describe('Geofence number inputs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives Cooldown a real range instead of none', () => {
    renderGeofence();
    const cooldown = screen.getByLabelText('automation.geofence_triggers.cooldown') as HTMLInputElement;
    expect(cooldown.getAttribute('min')).toBe('0');
    expect(cooldown.getAttribute('max')).toBe(String(GEOFENCE_COOLDOWN_MINUTES_MAX));
    expect(Number(cooldown.max)).toBeGreaterThan(0);
  });

  it('clamps Cooldown into range', () => {
    renderGeofence();
    const cooldown = screen.getByLabelText('automation.geofence_triggers.cooldown') as HTMLInputElement;
    fireEvent.change(cooldown, { target: { value: '999999' } });
    expect(cooldown.value).toBe(String(GEOFENCE_COOLDOWN_MINUTES_MAX));
    fireEvent.change(cooldown, { target: { value: '30' } });
    expect(cooldown.value).toBe('30');
  });

  it('gives the while-inside Interval a real range and clamps it', () => {
    renderGeofence();
    fireEvent.change(screen.getByDisplayValue('automation.geofence_triggers.event_entry'), { target: { value: 'while_inside' } });
    const interval = screen.getByLabelText('automation.geofence_triggers.while_inside_interval') as HTMLInputElement;
    expect(interval.getAttribute('min')).toBe('1');
    expect(interval.getAttribute('max')).toBe(String(GEOFENCE_INTERVAL_MINUTES_MAX));
    fireEvent.change(interval, { target: { value: '99999' } });
    expect(interval.value).toBe(String(GEOFENCE_INTERVAL_MINUTES_MAX));
    fireEvent.change(interval, { target: { value: '0' } });
    expect(interval.value).toBe('1');
  });
});

describe('clampInt', () => {
  it('parses, clamps and falls back to min on garbage', () => {
    expect(clampInt('42', 0, 100)).toBe(42);
    expect(clampInt('-5', 0, 100)).toBe(0);
    expect(clampInt('500', 0, 100)).toBe(100);
    expect(clampInt('', 1, 100)).toBe(1);
    expect(clampInt('abc', 0, 100)).toBe(0);
  });
});

describe('every Automation-page number input declares max', () => {
  // The sections AutomationTab mounts that render number inputs, plus the
  // Geofence map editor's circle fields.
  const files = [
    'AirtimeCutoffSection', 'AutoWelcomeSection', 'AutoFavoriteSection', 'AutoTracerouteSection',
    'AutoLocalStatsSection', 'AutoPingSection', 'AutoHeapManagementSection', 'RemoteAdminScannerSection',
    'AutoTimeSyncSection', 'AutoAcknowledgeSection', 'AutoAnnounceSection', 'AutoResponderSection',
    'AutoKeyManagementSection', 'TimerTriggersSection', 'GeofenceTriggersSection', 'GeofenceMapEditor',
    'AutoDeleteByDistanceSection', 'IgnoredNodesSection', 'forwarding/ForwardingSection',
  ];

  it.each(files)('%s', (name) => {
    const src = readFileSync(resolve(`src/components/${name}.tsx`), 'utf-8');
    const missing: number[] = [];
    for (const m of src.matchAll(/<input\b([\s\S]*?)\/>/g)) {
      if (/type="number"/.test(m[1]) && !/\bmax=/.test(m[1])) {
        missing.push(src.slice(0, m.index).split('\n').length);
      }
    }
    expect(missing, `number inputs without max at lines ${missing.join(', ')}`).toEqual([]);
  });
});
