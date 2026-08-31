/**
 * @vitest-environment jsdom
 *
 * MuteRuleDialog (#4964 report reorganization, WP5, spec §6.4/§10.5): shows
 * the UNFILTERED open count (not a filtered view's count), the copy names
 * the auto-close run count and computed days, and confirm writes BOTH
 * settings keys via `buildRuleMuteSettingsPatch` (the §5.2 trap this helper
 * exists to prevent).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) Object.entries(options).forEach(([k, v]) => { result = result.replace(`{{${k}}}`, String(v)); });
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../../services/api')>();
  return { __esModule: true, default: { get: vi.fn(), post: vi.fn(), setBaseUrl: vi.fn() }, ApiError: actual.ApiError };
});

import apiService, { ApiError } from '../../../services/api';
import MuteRuleDialog from './MuteRuleDialog';
import type { MeshIssuesSummary } from '../meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function summaryResponse(total: number): { success: true; data: MeshIssuesSummary } {
  return {
    success: true,
    data: {
      byType: [
        {
          issueType: 'B7_coverage_shadow',
          total,
          bySeverity: { critical: 0, warning: 0, info: total },
          worstSeverity: 'info',
          dismissed: 0,
          latestDetected: Date.UTC(2026, 7, 20),
        },
      ],
      byNode: [],
      counts: { critical: 0, warning: 0, info: total, total, dismissed: 0 },
      total,
      sourceNames: {},
    },
  };
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof MuteRuleDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MuteRuleDialog
        issueType="B7_coverage_shadow"
        disabledRules={[]}
        autoCloseCleanRuns={3}
        frequencyHours={24}
        onClose={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe('MuteRuleDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiService.get as Mocked).mockResolvedValue(summaryResponse(582));
    (apiService.post as Mocked).mockResolvedValue({ success: true });
  });

  it('fetches an unfiltered /summary and shows the true open count for the type', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    const url = (apiService.get as Mocked).mock.calls[0][0] as string;
    expect(url).toContain('/api/analysis/mesh-issues/summary');
    // No severity/tier/source/q/includeClosed/includeDismissed params — an
    // unfiltered request (spec §6.4: NOT the filtered view's count).
    expect(url).not.toContain('severity=');
    expect(url).not.toContain('includeDismissed=');
  });

  it('names the auto-close run count and computes days from frequencyHours', async () => {
    renderDialog({ autoCloseCleanRuns: 3, frequencyHours: 24 });
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    // 3 runs * 24h / 24 = 3 days.
    expect(screen.getByText(/auto-close after 3 analysis runs/)).toBeInTheDocument();
    expect(screen.getByText(/about 3 days/)).toBeInTheDocument();
  });

  it('confirm writes BOTH settings keys via buildRuleMuteSettingsPatch (§5.2 trap)', async () => {
    renderDialog({ disabledRules: ['A1_deprecated_role'] });
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mute-confirm-go'));

    await waitFor(() => expect(apiService.post).toHaveBeenCalledTimes(1));
    expect(apiService.post).toHaveBeenCalledWith('/api/settings', {
      mesh_issues_disabled_rules: 'A1_deprecated_role,B7_coverage_shadow',
      mesh_issues_b7_enabled: 'false',
    });
  });

  it('awaits a fresh status and closes on success', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mute-confirm-go'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('bubbles a 401/403 to onForbidden and does not close the dialog', async () => {
    (apiService.post as Mocked).mockRejectedValue(new ApiError('Forbidden', 403, { code: 'FORBIDDEN' }));
    const onClose = vi.fn();
    const onForbidden = vi.fn();
    renderDialog({ onClose, onForbidden });
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mute-confirm-go'));

    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel closes without posting', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await waitFor(() => expect(screen.getByText(/582/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiService.post).not.toHaveBeenCalled();
  });
});
