/**
 * @vitest-environment jsdom
 *
 * Issue #5033 — the "silent on Meshtastic 2.8+" notice.
 *
 * These tests also pin the fail-open contract: a node whose firmware version we
 * do not know must never be told it is misconfigured.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Firmware28SilenceNotice } from './Firmware28SilenceNotice';
import type { DeviceInfo } from '../types/device';
import {
  FIRMWARE_28_SILENCE_THRESHOLD_MS,
  FIRMWARE_28_ACTIVE_WINDOW_MS,
  FIRMWARE_28_POSITION_DOC_URL,
  FIRMWARE_28_TELEMETRY_DOC_URL,
} from '../utils/firmware28Silence';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const STALE = NOW - 2 * FIRMWARE_28_SILENCE_THRESHOLD_MS;

function node(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 305419896,
    firmwareVersion: '2.8.0.abcdef',
    lastHeard: Math.floor((NOW - HOUR) / 1000),
    positionTimestamp: STALE,
    telemetryTimestamp: STALE,
    ...overrides,
  };
}

const NOTICE = 'firmware28-silence-notice';

describe('Firmware28SilenceNotice', () => {
  it('renders for a silent 2.8 node that is still being heard', () => {
    render(<Firmware28SilenceNotice node={node()} nowMs={NOW} />);
    expect(screen.getByTestId(NOTICE)).toBeTruthy();
    expect(
      screen.getByText(/Position and telemetry are opt-in on Meshtastic 2\.8\+/),
    ).toBeTruthy();
    expect(
      screen.getByText(/stopped sending both position and telemetry/),
    ).toBeTruthy();
  });

  it('links the verified Meshtastic docs for both halves', () => {
    render(<Firmware28SilenceNotice node={node()} nowMs={NOW} />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    const hrefs = links.map(a => a.getAttribute('href'));
    expect(hrefs).toContain(FIRMWARE_28_POSITION_DOC_URL);
    expect(hrefs).toContain(FIRMWARE_28_TELEMETRY_DOC_URL);
    // External links must not hand the opener a window reference.
    for (const a of links) expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('renders nothing for a pre-2.8 node that is equally silent', () => {
    render(
      <Firmware28SilenceNotice node={node({ firmwareVersion: '2.7.11.aabbcc' })} nowMs={NOW} />,
    );
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('renders nothing for an active 2.8 node', () => {
    render(
      <Firmware28SilenceNotice
        node={node({ positionTimestamp: NOW - HOUR, telemetryTimestamp: NOW - HOUR })}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('renders nothing when the firmware version is unknown', () => {
    render(<Firmware28SilenceNotice node={node({ firmwareVersion: undefined })} nowMs={NOW} />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('renders nothing when the node itself is absent', () => {
    render(<Firmware28SilenceNotice node={null} nowMs={NOW} />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('renders nothing once the node has dropped off the mesh', () => {
    render(
      <Firmware28SilenceNotice
        node={node({ lastHeard: Math.floor((NOW - FIRMWARE_28_ACTIVE_WINDOW_MS - HOUR) / 1000) })}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('fires exactly at the silence threshold and not one ms before', () => {
    const { unmount } = render(
      <Firmware28SilenceNotice
        node={node({
          positionTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS,
          telemetryTimestamp: undefined,
        })}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId(NOTICE)).toBeTruthy();
    unmount();

    render(
      <Firmware28SilenceNotice
        node={node({
          positionTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS + 1,
          telemetryTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS + 1,
        })}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('names only the half that went quiet', () => {
    const { unmount } = render(
      <Firmware28SilenceNotice node={node({ telemetryTimestamp: undefined })} nowMs={NOW} />,
    );
    expect(screen.getByText(/stopped sending position, but/)).toBeTruthy();
    unmount();

    render(<Firmware28SilenceNotice node={node({ positionTimestamp: undefined })} nowMs={NOW} />);
    expect(screen.getByText(/stopped sending telemetry, but/)).toBeTruthy();
  });

  it('falls back to the nested user.firmwareVersion when the column is unset', () => {
    render(
      <Firmware28SilenceNotice
        node={node({
          firmwareVersion: undefined,
          user: { id: '!12345678', firmwareVersion: '2.8.0.abcdef' },
        })}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId(NOTICE)).toBeTruthy();
  });
});
