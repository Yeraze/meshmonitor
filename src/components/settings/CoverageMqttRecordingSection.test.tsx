/**
 * CoverageMqttRecordingSection — per-source reception-recording toggle for
 * the Coverage Report: MQTT gateway receptions (#5277 P2 WP3, spec §2.8/§3)
 * on `mqtt_broker`/`mqtt_bridge` sources, and MeshCore observer receptions
 * (#5277 P3 WP4, spec §2.7/§3) on a `meshcore_mqtt` source.
 *
 * Covers: loads the current value on mount, enabling opens a styled confirm
 * dialog (#5277 P4a WP6) and POSTs '1' only on its confirm button (Cancel
 * and Escape both leave the toggle off and post nothing), disabling posts
 * '0' without opening any dialog, the MQTT warning quotes the measured
 * numbers and links global retention, a successful save invalidates the
 * receivers query, and the MeshCore observer copy swaps in for
 * `meshcore_mqtt` — its warning and confirm dialog say the volume is
 * unmeasured and never quote the Meshtastic MQTT numbers.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoverageMqttRecordingSection } from './CoverageMqttRecordingSection';

// Local override of the global react-i18next mock (src/test/setup.ts), which
// returns the raw key rather than the English default — this suite asserts
// on the literal rendered text (the measured numbers / unmeasured wording),
// so it needs real fallback resolution, following the
// MeshCoreSettingsView.receiveOnly.test.tsx convention.
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
  // this mirrors that behavior for the two keys the component uses, using
  // the same English text as public/locales/en.json's
  // `settings.coverage_mqtt_warning` / `settings.coverage_observer_warning`.
  Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, React.ReactElement> }) => {
    const templates: Record<string, string> = {
      'settings.coverage_mqtt_warning':
        'Each gateway that hears a position packet adds one row. A regional feed adds about ' +
        '12,000–14,000 rows a day: about 90,000–100,000 rows (35–50 MB) over a 7-day retention. ' +
        'A world-wide msh/# feed can reach about 1 million rows a day and several GB a week. ' +
        'Rows are kept for the Coverage retention period, a global setting under <link>Settings → Coverage Report</link>.',
      'settings.coverage_observer_warning':
        'Each observer that hears a MeshCore advert with a position adds one row, and many ' +
        'observers can hear one advert over several paths. We have not measured how many rows a ' +
        'MeshCore region feed produces; watch your database size after turning this on. Rows are ' +
        'kept for the Coverage retention period, a global setting under <link>Settings → Coverage Report</link>.',
    };
    const template = templates[i18nKey];
    if (!template) return null;
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

function renderSection(overrides: Partial<{ canWrite: boolean; sourceId: string; sourceType: string }> = {}) {
  return render(
    <MemoryRouter>
      <CoverageMqttRecordingSection
        baseUrl=""
        sourceId={overrides.sourceId ?? 'src-a'}
        canWrite={overrides.canWrite ?? true}
        sourceType={overrides.sourceType ?? 'mqtt_broker'}
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

  it('enabling opens a styled confirm dialog with the title, body paragraphs and buttons', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Turn on coverage recording?')).toBeInTheDocument();
    // Body text is the unchanged settings.coverage_mqtt_enable_confirm string, split
    // into paragraphs on blank lines, with the trailing "Continue?" line dropped.
    expect(within(dialog).getByText('Record MQTT gateway receptions for the Coverage Report?')).toBeInTheDocument();
    expect(within(dialog).getByText(/A regional feed adds about/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Continue?')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Turn on recording' })).toBeInTheDocument();
    // No save yet — nothing happens until the confirm button is clicked.
    expect(h.csrfFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('enabling POSTs "1" when the dialog is confirmed', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Turn on recording' }).click();

    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [url, init] = h.csrfFetch.mock.calls[0];
    expect(url).toBe('/api/settings?sourceId=src-a');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '1' });

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('enabling posts nothing when the dialog is cancelled', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Cancel' }).click();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.csrfFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('enabling posts nothing when the dialog is closed with Escape', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.csrfFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('disabling posts "0" without opening the confirm dialog', async () => {
    h.apiGet.mockResolvedValue({ coverage_mqtt_enabled: '1' });
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());

    screen.getByRole('checkbox').click();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [, init] = h.csrfFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '0' });
  });

  it('invalidates the receivers query after a successful save', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

    screen.getByRole('checkbox').click();
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('button', { name: 'Turn on recording' }).click();

    await waitFor(() => expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['analysis', 'coverageReport', 'receivers'],
    }));
  });

  it('shows the warning with the measured numbers and the global-retention link for an MQTT source', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection({ sourceType: 'mqtt_broker' });
    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

    expect(screen.getByText(/12,000.{1}14,000 rows a day/)).toBeInTheDocument();
    expect(screen.getByText(/90,000.{1}100,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/35.{1}50 MB/)).toBeInTheDocument();
    expect(screen.getByText(/1 million rows a day/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /Coverage Report/i });
    expect(link).toHaveAttribute('href', '/settings#settings-coverage');
  });

  it('shows the same P2 MQTT copy for an mqtt_bridge source', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection({ sourceType: 'mqtt_bridge' });
    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

    expect(screen.getByText('Record MQTT gateway receptions for the Coverage Report')).toBeInTheDocument();
    expect(screen.getByText(/12,000.{1}14,000 rows a day/)).toBeInTheDocument();
  });

  it('disables the checkbox for a read-only caller', async () => {
    h.apiGet.mockResolvedValue({});
    renderSection({ canWrite: false });
    await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  // #5277 P3 WP4: MeshCore Observer (`meshcore_mqtt`) copy.
  describe('MeshCore observer source (meshcore_mqtt)', () => {
    it('shows the observer toggle label', async () => {
      h.apiGet.mockResolvedValue({});
      renderSection({ sourceType: 'meshcore_mqtt' });
      await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

      expect(screen.getByText('Record MeshCore observer receptions for the Coverage Report')).toBeInTheDocument();
    });

    it('warns that row volume is unmeasured and quotes none of the Meshtastic MQTT numbers', async () => {
      h.apiGet.mockResolvedValue({});
      renderSection({ sourceType: 'meshcore_mqtt' });
      await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

      expect(screen.getByText(/have not measured how many rows/)).toBeInTheDocument();

      const warningText = document.body.textContent ?? '';
      expect(warningText).not.toMatch(/12,000/);
      expect(warningText).not.toMatch(/14,000/);
      expect(warningText).not.toMatch(/35.{1}50 MB/);
      expect(warningText).not.toMatch(/1 million rows/);

      const link = screen.getByRole('link', { name: /Coverage Report/i });
      expect(link).toHaveAttribute('href', '/settings#settings-coverage');
    });

    it('shows the signed-position note instead of the MQTT "OK to MQTT" note', async () => {
      h.apiGet.mockResolvedValue({});
      renderSection({ sourceType: 'meshcore_mqtt' });
      await waitFor(() => expect(h.apiGet).toHaveBeenCalled());

      expect(screen.getByText(/Only adverts that carry a position and a valid signature are recorded\./)).toBeInTheDocument();
      expect(screen.queryByText(/OK to MQTT/)).not.toBeInTheDocument();
    });

    it('enabling opens the dialog with the observer wording and POSTs "1" on confirm', async () => {
      h.apiGet.mockResolvedValue({});
      renderSection({ sourceType: 'meshcore_mqtt', sourceId: 'src-observer' });
      await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());

      screen.getByRole('checkbox').click();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Turn on coverage recording?')).toBeInTheDocument();
      expect(within(dialog).getByText(/have not measured how many rows/)).toBeInTheDocument();
      const dialogText = dialog.textContent ?? '';
      expect(dialogText).not.toMatch(/12,000/);

      within(dialog).getByRole('button', { name: 'Turn on recording' }).click();

      await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
      const [url, init] = h.csrfFetch.mock.calls[0];
      expect(url).toBe('/api/settings?sourceId=src-observer');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '1' });

      await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    });

    it('disabling posts "0" without opening the confirm dialog', async () => {
      h.apiGet.mockResolvedValue({ coverage_mqtt_enabled: '1' });
      renderSection({ sourceType: 'meshcore_mqtt' });
      await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());

      screen.getByRole('checkbox').click();

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
      const [, init] = h.csrfFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ coverage_mqtt_enabled: '0' });
    });
  });
});
