/**
 * CoverageMqttRecordingSection — per-source MQTT gateway-reception recording
 * toggle for the Coverage Report (#5277 P2 WP3, spec §2.8/§3).
 *
 * Covers: loads the current value on mount, enabling asks confirm and POSTs
 * '1' (cancel posts nothing), disabling posts '0' without confirm, the
 * warning quotes the measured numbers and links global retention, and a
 * successful save invalidates the receivers query.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoverageMqttRecordingSection } from './CoverageMqttRecordingSection';

// Local override of the global react-i18next mock (src/test/setup.ts), which
// returns the raw key rather than the English default — this suite asserts
// on the literal rendered text (the measured numbers), so it needs real
// fallback resolution, following the MeshCoreSettingsView.receiveOnly.test.tsx
// convention.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => {
      let out = typeof fallback === 'string' ? fallback : key;
      if (vars) {
        Object.entries(vars).forEach(([k, v]) => {
          out = out.replace(`{{${k}}}`, String(v));
        });
      }
      return out;
    },
  }),
  // The real Trans resolves `i18nKey` against loaded resources and swaps
  // <link>...</link> for `components.link`. Tests carry no i18n resources, so
  // this mirrors that behavior for the one key the component uses, using the
  // same English text as public/locales/en.json's
  // `settings.coverage_mqtt_warning`.
  Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, React.ReactElement> }) => {
    if (i18nKey !== 'settings.coverage_mqtt_warning') return null;
    const template =
      'Each gateway that hears a position packet adds one row. A regional feed adds about ' +
      '12,000–14,000 rows a day: about 90,000–100,000 rows (35–50 MB) over a 7-day retention. ' +
      'A world-wide msh/# feed can reach about 1 million rows a day and several GB a week. ' +
      'Rows are kept for the Coverage retention period, a global setting under <link>Settings → Coverage Report</link>.';
    const [before, rest] = template.split('<link>');
    const [linkText, after] = rest.split('</link>');
    const link = components?.link;
    return (
      <>
        {before}
        {link ? React.cloneElement(link, undefined, linkText) : linkText}
        {after}
      </>
    );
  },
}));

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  csrfFetch: vi.fn(),
  showToast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: { get: h.apiGet },
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

function renderSection(overrides: Partial<{ canWrite: boolean; sourceId: string }> = {}) {
  return render(
    <MemoryRouter>
      <CoverageMqttRecordingSection
        baseUrl=""
        sourceId={overrides.sourceId ?? 'src-a'}
        canWrite={overrides.canWrite ?? true}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.apiGet.mockResolvedValue({});
  h.csrfFetch.mockResolvedValue({ ok: true });
});

describe('CoverageMqttRecordingSection', () => {
  it('loads the current value on mount and reflects it', async () => {
    h.apiGet.mockResolvedValue({ coverage_mqtt_enabled: '1' });
    renderSection();

    expect(h.apiGet).toHaveBeenCalledWith('/api/settings?sourceId=src-a');
    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeChecked();
    });
  });

  it('starts unchecked when the flag is off or absent', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();

    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('also accepts the "true" spelling of the flag', async () => {
    h.apiGet.mockResolvedValue({ coverage_mqtt_enabled: 'true' });
    renderSection();

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  });

  it('enabling asks for confirmation and POSTs "1" on confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [url, init] = h.csrfFetch.mock.calls[0];
    expect(url).toBe('/api/settings?sourceId=src-a');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '1' });

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    confirmSpy.mockRestore();
  });

  it('enabling posts nothing when the confirm is cancelled', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();

    expect(confirmSpy).toHaveBeenCalled();
    expect(h.csrfFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    confirmSpy.mockRestore();
  });

  it('disabling posts "0" without asking for confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    h.apiGet.mockResolvedValue({ coverage_mqtt_enabled: '1' });
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());

    screen.getByRole('checkbox').click();

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [, init] = h.csrfFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '0' });
    confirmSpy.mockRestore();
  });

  it('invalidates the receivers query after a successful save', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();

    await waitFor(() => expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['analysis', 'coverageReport', 'receivers'],
    }));
  });

  it('shows the warning with the measured numbers and the global-retention link', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

    expect(screen.getByText(/12,000.{1}14,000 rows a day/)).toBeInTheDocument();
    expect(screen.getByText(/90,000.{1}100,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/35.{1}50 MB/)).toBeInTheDocument();
    expect(screen.getByText(/1 million rows a day/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /Coverage Report/i });
    expect(link).toHaveAttribute('href', '/settings#settings-coverage');
  });

  it('disables the checkbox for a read-only caller', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection({ canWrite: false });
    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});
