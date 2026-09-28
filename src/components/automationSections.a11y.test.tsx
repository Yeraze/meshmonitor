/**
 * @vitest-environment jsdom
 *
 * Accessible names for controls that had none: the Auto Responder enable
 * checkbox (it sits inside the section heading, so it gets an aria-label) and
 * the Geofence Event select (its visible "Event:" label is now associated).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AutoResponderSection from './AutoResponderSection';
import GeofenceTriggersSection from './GeofenceTriggersSection';

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => undefined }));
vi.mock('../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ scripts: [] }) } }));
vi.mock('./GeofenceMapEditor', () => ({ default: () => <div data-testid="geofence-map-editor" /> }));
vi.mock('./GeofenceNodeSelector', () => ({ default: () => <div data-testid="geofence-node-selector" /> }));

const noop = () => {};

describe('Automation control accessible names', () => {
  it('names the Auto Responder enable checkbox', () => {
    render(
      <AutoResponderSection
        enabled={false}
        triggers={[]}
        channels={[]}
        skipIncompleteNodes={false}
        baseUrl=""
        onEnabledChange={noop}
        onTriggersChange={noop}
        onSkipIncompleteNodesChange={noop}
      />,
    );
    // The global i18n test mock returns the key.
    const toggle = screen.getByRole('checkbox', { name: 'auto_responder.enable_aria' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('associates the Geofence Event label with its select', () => {
    render(<GeofenceTriggersSection triggers={[]} channels={[]} nodes={[]} baseUrl="" onTriggersChange={noop} />);
    const select = screen.getByRole('combobox', { name: 'automation.geofence_triggers.event' });
    expect((select as HTMLSelectElement).value).toBe('entry');
  });
});
