/**
 * @vitest-environment jsdom
 *
 * #5014 Phase 2 WP3 §7.3. Mocks useObserverStatus (not ApiService) so this
 * stays a rendering test.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreObserverBrokerPanel } from './MeshCoreObserverBrokerPanel';
import { useObserverStatus } from './hooks/useObserverStatus';
import type { ObserverBrokerStatus, ObserverStatusResponse } from '../../services/api';

vi.mock('./hooks/useObserverStatus', () => ({
  useObserverStatus: vi.fn(),
}));

const mockedUseObserverStatus = vi.mocked(useObserverStatus);

function mockStatus(status: ObserverStatusResponse | null, error: Error | null = null) {
  mockedUseObserverStatus.mockReturnValue({
    status,
    loading: false,
    error,
    refetch: vi.fn(),
  });
}

const makeBroker = (overrides: Partial<ObserverBrokerStatus> = {}): ObserverBrokerStatus => ({
  key: 'wss://mqtt.meshmapper.net:443',
  url: 'wss://mqtt.meshmapper.net:443',
  label: 'MeshMapper',
  authMode: 'token',
  tokenAudience: 'mqtt.meshmapper.net',
  configured: true,
  keyStored: true,
  connected: true,
  publishes: 10,
  dropped: 0,
  lastPublishAt: 1_700_000_000_000,
  lastError: null,
  tokenExpiresAt: null,
  ...overrides,
});

const makeStatus = (
  brokers: ObserverBrokerStatus[],
  overrides: Partial<ObserverStatusResponse> = {},
): ObserverStatusResponse => ({
  running: true,
  configured: true,
  authMode: 'token',
  keyStored: true,
  connected: true,
  publishes: 0,
  dropped: 0,
  lastPublishAt: null,
  lastError: null,
  tokenExpiresAt: null,
  brokers,
  ...overrides,
});

describe('MeshCoreObserverBrokerPanel', () => {
  it('renders two cards for two brokers, preferring labels over URLs, with URL shown beneath', () => {
    const brokers = [
      makeBroker({ key: 'a', url: 'wss://a.example.com:443', label: 'Alpha' }),
      makeBroker({ key: 'b', url: 'wss://b.example.com:443', label: null }),
    ];
    mockStatus(makeStatus(brokers));
    render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('wss://a.example.com:443')).toBeInTheDocument();
    // Broker b has no label, so its title IS the URL — it appears once, not
    // duplicated beneath.
    expect(screen.getAllByText('wss://b.example.com:443')).toHaveLength(1);
  });

  it('gives a connected broker statusOn and a disconnected one statusOff', () => {
    const brokers = [
      makeBroker({ key: 'a', connected: true }),
      makeBroker({ key: 'b', connected: false, label: 'Down' }),
    ];
    mockStatus(makeStatus(brokers));
    const { container } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(container.querySelectorAll('[data-ui-icon="statusOn"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ui-icon="statusOff"]')).toHaveLength(1);
    expect(screen.getByText('meshcore.observer.status_disconnected')).toBeInTheDocument();
    expect(screen.getByText('meshcore.observer.status_connected')).toBeInTheDocument();
  });

  it('renders publishes/dropped, showing the dropped hint only when dropped > 0', () => {
    const brokers = [makeBroker({ key: 'a', publishes: 42, dropped: 0 })];
    mockStatus(makeStatus(brokers));
    const { rerender } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('meshcore.observer.dropped_help')).not.toBeInTheDocument();

    mockStatus(makeStatus([makeBroker({ key: 'a', publishes: 42, dropped: 3 })]));
    rerender(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.getByText('meshcore.observer.dropped_help')).toBeInTheDocument();
  });

  it('renders lastPublishAt via formatRelativeTime (ms, not x1000); null shows Never', () => {
    // A few seconds ago in MILLISECONDS. If the component wrongly treated
    // this as seconds (x1000), it would render as a time far in the future
    // instead of "just now".
    const recentMs = Date.now() - 5000;
    mockStatus(makeStatus([makeBroker({ key: 'a', lastPublishAt: recentMs })]));
    const { rerender } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.queryByText('common.never')).not.toBeInTheDocument();

    mockStatus(makeStatus([makeBroker({ key: 'a', lastPublishAt: null })]));
    rerender(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.getByText('common.never')).toBeInTheDocument();
  });

  it('renders tokenExpiresAt as an absolute local time and hides it in password mode', () => {
    const futureSeconds = Math.floor(Date.now() / 1000) + 24 * 3600;
    mockStatus(makeStatus([makeBroker({ key: 'a', authMode: 'token', tokenExpiresAt: futureSeconds })]));
    const { rerender } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    const expected = new Date(futureSeconds * 1000).toLocaleString();
    expect(screen.getByText(expected)).toBeInTheDocument();

    mockStatus(makeStatus([makeBroker({ key: 'a', authMode: 'password', tokenExpiresAt: futureSeconds })]));
    rerender(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.queryByText('meshcore.observer.token_expires')).not.toBeInTheDocument();
  });

  it('renders lastError with role=alert', () => {
    mockStatus(makeStatus([makeBroker({ key: 'a', lastError: 'ECONNREFUSED' })]));
    render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    const alert = screen.getAllByRole('alert').find((el) => el.textContent?.includes('ECONNREFUSED'));
    expect(alert).toBeTruthy();
  });

  it('renders configured:false and keyStored:false as separate role=alert warnings with password-mode wording', () => {
    mockStatus(
      makeStatus([
        makeBroker({ key: 'a', configured: false, keyStored: false, authMode: 'password' }),
      ]),
    );
    render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(screen.getByText('meshcore.observer.broker_not_configured')).toBeInTheDocument();
    expect(screen.getByText('meshcore.observer.no_credentials_running')).toBeInTheDocument();
    expect(screen.queryByText('meshcore.observer.no_key_running')).not.toBeInTheDocument();
  });

  it('shows the "publisher not running" hint when status.running is false', () => {
    mockStatus(makeStatus([makeBroker()], { running: false }));
    render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(screen.getByText('meshcore.observer.publisher_not_running')).toBeInTheDocument();
  });

  it('renders nothing for an empty brokers array', () => {
    mockStatus(makeStatus([]));
    const { container } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when status is null', () => {
    mockStatus(null);
    const { container } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on error', () => {
    mockStatus(makeStatus([makeBroker()]), new Error('boom'));
    const { container } = render(<MeshCoreObserverBrokerPanel sourceId="src-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
