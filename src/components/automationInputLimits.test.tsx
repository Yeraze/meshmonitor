/**
 * @vitest-environment jsdom
 *
 * Number inputs on the Automation page must declare a real `max`.
 *
 * With `max` absent, Chrome exposes the spinbutton with `aria-valuemax="0"`, so
 * the Geofence Cooldown field read as a 0-to-0 range while it took any value.
 * These tests pin the Geofence inputs' bounds, then sweep every number input in
 * the Automation sections so a new one cannot ship without a `max`.
 *
 * #5649: the fields no longer clamp a keystroke into range (that is what made
 * them impossible to clear). Out-of-range text stays as typed, is marked
 * invalid, and blocks the form's button, so the limit still holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import {
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

  it('refuses a Cooldown past the max instead of clamping the keystroke (#5649)', () => {
    renderGeofence();
    const cooldown = screen.getByLabelText('automation.geofence_triggers.cooldown') as HTMLInputElement;
    fireEvent.change(cooldown, { target: { value: '999999' } });
    expect(cooldown.value).toBe('999999');
    expect(cooldown.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(cooldown, { target: { value: '30' } });
    expect(cooldown.value).toBe('30');
    expect(cooldown.getAttribute('aria-invalid')).toBeNull();
  });

  it('gives the while-inside Interval a real range and refuses values outside it', () => {
    renderGeofence();
    fireEvent.change(screen.getByDisplayValue('automation.geofence_triggers.event_entry'), { target: { value: 'while_inside' } });
    const interval = screen.getByLabelText('automation.geofence_triggers.while_inside_interval') as HTMLInputElement;
    expect(interval.getAttribute('min')).toBe('1');
    expect(interval.getAttribute('max')).toBe(String(GEOFENCE_INTERVAL_MINUTES_MAX));
    fireEvent.change(interval, { target: { value: '99999' } });
    expect(interval.value).toBe('99999');
    expect(interval.getAttribute('aria-invalid')).toBe('true');
    // Below the floor: red and held back, never swapped for 0 or for the minimum.
    fireEvent.change(interval, { target: { value: '0' } });
    expect(interval.value).toBe('0');
    expect(interval.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(interval, { target: { value: '15' } });
    expect(interval.getAttribute('aria-invalid')).toBeNull();
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
    // Number fields are `<NumberInput>` since #5649; a raw one (the map
    // editor's circle fields) is still swept.
    for (const m of src.matchAll(/<(input|NumberInput)\b([\s\S]*?)\/>/g)) {
      const isNumber = m[1] === 'NumberInput' || /type="number"/.test(m[2]);
      if (isNumber && !/\bmax=/.test(m[2])) {
        missing.push(src.slice(0, m.index).split('\n').length);
      }
    }
    expect(missing, `number inputs without max at lines ${missing.join(', ')}`).toEqual([]);
  });
});
