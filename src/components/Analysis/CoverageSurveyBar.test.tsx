/**
 * CoverageSurveyBar — #5277 P4b WP3 (COVERAGE_P4_SPEC.md §2b.7).
 *
 * `useCoverageSurveys`/mutations, `useAuth`, and `useToast` are all mocked —
 * this file exercises the bar's own picker/gating/dialog wiring, not
 * TanStack Query or the auth context. `CoverageReport.test.tsx` covers what
 * CoverageReport does with `onSelectSurvey`.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoverageSurveyBar } from './CoverageSurveyBar';
import { ApiError } from '../../services/api';
import type { CoverageSurveyDto } from '../../types/coverage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

const h = vi.hoisted(() => ({
  authenticated: true,
  showToast: vi.fn(),
  surveysData: [] as CoverageSurveyDto[],
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  stopMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: h.authenticated } }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: h.showToast }),
}));

vi.mock('../../hooks/useCoverageSurveys', () => ({
  useCoverageSurveys: () => ({ data: h.surveysData, isLoading: false }),
  useCreateSurvey: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateSurvey: () => ({ mutate: h.updateMutate, isPending: false }),
  useStopSurvey: () => ({ mutate: h.stopMutate, isPending: false }),
  useDeleteSurvey: () => ({ mutate: h.deleteMutate, isPending: false }),
}));

function makeSurvey(overrides: Partial<CoverageSurveyDto> = {}): CoverageSurveyDto {
  return {
    id: 'survey-1',
    name: 'Car-01 drive',
    senderId: '!bbbbbbbb',
    startAt: 1_700_000_000_000,
    endAt: 1_700_000_600_000,
    receivers: null,
    intervalSec: null,
    notes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    effectiveEndAt: 1_700_000_600_000,
    isLive: false,
    canEdit: true,
    createdByMe: true,
    ...overrides,
  };
}

function renderBar(props: Partial<React.ComponentProps<typeof CoverageSurveyBar>> = {}) {
  const onSelectSurvey = props.onSelectSurvey ?? vi.fn();
  const utils = render(
    <CoverageSurveyBar
      senderId={props.senderId ?? '!bbbbbbbb'}
      senderLabel={props.senderLabel ?? 'Car-01'}
      currentSinceMs={props.currentSinceMs ?? 1_700_000_000_000}
      currentUntilMs={props.currentUntilMs ?? 1_700_003_600_000}
      currentReceiversEncoded={props.currentReceiversEncoded ?? null}
      selectedSurveyId={props.selectedSurveyId ?? null}
      onSelectSurvey={onSelectSurvey}
    />,
  );
  return { ...utils, onSelectSurvey };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authenticated = true;
  h.surveysData = [];
});

describe('CoverageSurveyBar', () => {
  it('U2: renders nothing at all when the viewer is anonymous', () => {
    h.authenticated = false;
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the picker and Start/Save buttons for an authenticated user with no surveys', () => {
    renderBar();
    expect(screen.getByRole('combobox', { name: 'Survey' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start survey/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save as survey/ })).toBeInTheDocument();
  });

  it('Start and Save are disabled when no sender is selected', () => {
    renderBar({ senderId: '' });
    expect(screen.getByRole('button', { name: /Start survey/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save as survey/ })).toBeDisabled();
  });

  it('Save is disabled when the current window is longer than 7 days', () => {
    renderBar({ currentSinceMs: 0, currentUntilMs: 8 * 24 * 3_600_000 });
    expect(screen.getByRole('button', { name: /Save as survey/ })).toBeDisabled();
  });

  it('shows no Stop/Edit/Delete buttons and no live badge when nothing is selected', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: /Stop survey/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('coverage-survey-live-badge')).not.toBeInTheDocument();
  });

  it('picking a survey from the picker calls onSelectSurvey with the full DTO', async () => {
    const survey = makeSurvey();
    h.surveysData = [survey];
    const user = userEvent.setup({ delay: null });
    const { onSelectSurvey } = renderBar();

    const combobox = screen.getByRole('combobox', { name: 'Survey' });
    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: /Car-01 drive/ }));

    expect(onSelectSurvey).toHaveBeenCalledWith(survey);
  });

  it('picking "No survey" calls onSelectSurvey(null)', async () => {
    const survey = makeSurvey();
    h.surveysData = [survey];
    const user = userEvent.setup({ delay: null });
    const { onSelectSurvey } = renderBar({ selectedSurveyId: 'survey-1' });

    const combobox = screen.getByRole('combobox', { name: 'Survey' });
    await user.click(combobox);
    await user.click(screen.getByRole('option', { name: 'No survey' }));

    expect(onSelectSurvey).toHaveBeenCalledWith(null);
  });

  it('a live survey option is labelled distinctly in the picker', async () => {
    h.surveysData = [makeSurvey({ id: 'survey-2', name: 'Live one', isLive: true, endAt: null })];
    const user = userEvent.setup({ delay: null });
    renderBar();

    await user.click(screen.getByRole('combobox', { name: 'Survey' }));
    expect(screen.getByRole('option', { name: /Live one \(live\)/ })).toBeInTheDocument();
  });

  describe('live badge and Stop', () => {
    it('shows the live badge with elapsed time and auto-end when the selected survey is live', () => {
      const survey = makeSurvey({ isLive: true, endAt: null, startAt: Date.now() - 60_000 });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      const badge = screen.getByTestId('coverage-survey-live-badge');
      expect(within(badge).getByText(/Live —/)).toBeInTheDocument();
      expect(within(badge).getByText(/Auto-ends at/)).toBeInTheDocument();
    });

    it('shows Stop for a live survey the viewer can edit, and calls stopSurvey.mutate on click', () => {
      const survey = makeSurvey({ isLive: true, endAt: null, canEdit: true });
      h.surveysData = [survey];
      const { onSelectSurvey } = renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /Stop survey/ }));
      expect(h.stopMutate).toHaveBeenCalledWith('survey-1', expect.objectContaining({ onSuccess: expect.any(Function) }));

      // Simulate the mutation succeeding.
      const stoppedSurvey = { ...survey, isLive: false, endAt: Date.now() };
      act(() => h.stopMutate.mock.calls[0][1].onSuccess(stoppedSurvey));
      expect(onSelectSurvey).toHaveBeenCalledWith(stoppedSurvey);
    });

    it('does not show Stop for a live survey the viewer cannot edit', () => {
      const survey = makeSurvey({ isLive: true, endAt: null, canEdit: false });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      expect(screen.queryByRole('button', { name: /Stop survey/ })).not.toBeInTheDocument();
    });

    it('does not show Stop for a non-live survey even when canEdit', () => {
      const survey = makeSurvey({ isLive: false, canEdit: true });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      expect(screen.queryByRole('button', { name: /Stop survey/ })).not.toBeInTheDocument();
    });
  });

  describe('Edit/Delete gating (U2: canEdit only)', () => {
    it('shows Edit and Delete for a selected survey the viewer can edit', () => {
      const survey = makeSurvey({ canEdit: true });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
    });

    it('hides Edit and Delete for a selected survey the viewer cannot edit', () => {
      const survey = makeSurvey({ canEdit: false });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
    });
  });

  describe('Start survey', () => {
    it('opens a modal prefilled with a default name, and confirms via createSurvey.mutate(live: true)', () => {
      const { onSelectSurvey } = renderBar({ senderId: '!bbbbbbbb', senderLabel: 'Car-01' });

      fireEvent.click(screen.getByRole('button', { name: /Start survey/ }));
      expect(screen.getByText(/MeshMonitor sends nothing/)).toBeInTheDocument();
      const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
      expect(nameInput.value.startsWith('Car-01 ')).toBe(true);

      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start survey' }));

      expect(h.createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: '!bbbbbbbb', live: true }),
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );

      const created = makeSurvey({ id: 'new-1', isLive: true, endAt: null });
      act(() => h.createMutate.mock.calls[0][1].onSuccess(created));
      expect(onSelectSurvey).toHaveBeenCalledWith(created);
      // Modal closes after success.
      expect(screen.queryByText(/MeshMonitor sends nothing/)).not.toBeInTheDocument();
    });

    it('maps SURVEY_ALREADY_LIVE to a translated toast on error', () => {
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: /Start survey/ }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start survey' }));

      const error = new ApiError('conflict', 409, { code: 'SURVEY_ALREADY_LIVE' });
      act(() => h.createMutate.mock.calls[0][1].onError(error));

      expect(h.showToast).toHaveBeenCalledWith(
        'This sender already has a live survey running.',
        'error',
      );
    });
  });

  describe('Save as survey', () => {
    it('confirms via createSurvey.mutate with the current window and receiver filter, live omitted', () => {
      const { onSelectSurvey } = renderBar({
        currentSinceMs: 1_700_000_000_000,
        currentUntilMs: 1_700_003_600_000,
        currentReceiversEncoded: 'src-a:+!aaaaaaaa',
      });

      fireEvent.click(screen.getByRole('button', { name: /Save as survey/ }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save as survey' }));

      expect(h.createMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          startAt: 1_700_000_000_000,
          endAt: 1_700_003_600_000,
          receivers: 'src-a:+!aaaaaaaa',
        }),
        expect.anything(),
      );
      expect(h.createMutate.mock.calls[0][0]).not.toHaveProperty('live');

      const saved = makeSurvey({ id: 'saved-1' });
      act(() => h.createMutate.mock.calls[0][1].onSuccess(saved));
      expect(onSelectSurvey).toHaveBeenCalledWith(saved);
    });
  });

  describe('Edit', () => {
    it('prefills name/notes/interval and confirms via updateSurvey.mutate', () => {
      const survey = makeSurvey({ name: 'Old name', notes: 'some notes', intervalSec: 45 });
      h.surveysData = [survey];
      const { onSelectSurvey } = renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Old name');
      expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('some notes');
      expect((screen.getByLabelText('Broadcast interval (seconds)') as HTMLInputElement).value).toBe('45');

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New name' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(h.updateMutate).toHaveBeenCalledWith(
        { id: 'survey-1', body: { name: 'New name', notes: 'some notes', intervalSec: 45 } },
        expect.anything(),
      );

      const updated = { ...survey, name: 'New name' };
      act(() => h.updateMutate.mock.calls[0][1].onSuccess(updated));
      expect(onSelectSurvey).toHaveBeenCalledWith(updated);
    });

    it('a non-numeric interval blocks Save changes with a validation message', () => {
      const survey = makeSurvey();
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
      fireEvent.change(screen.getByLabelText('Broadcast interval (seconds)'), { target: { value: 'not-a-number' } });

      expect(screen.getByText(/Enter a whole number of seconds/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('a blank interval clears it (sends null)', () => {
      const survey = makeSurvey({ intervalSec: 45 });
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
      fireEvent.change(screen.getByLabelText('Broadcast interval (seconds)'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(h.updateMutate).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ intervalSec: null }) }),
        expect.anything(),
      );
    });
  });

  describe('Delete', () => {
    it('confirms via the shared Modal (not window.confirm), and calls deleteSurvey.mutate', () => {
      const survey = makeSurvey();
      h.surveysData = [survey];
      const { onSelectSurvey } = renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
      expect(screen.getByText('Delete this survey?')).toBeInTheDocument();

      // Two "Delete" buttons exist once the dialog is open (the trigger
      // behind it + the dialog's own confirm) — scope to the dialog.
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Delete$/ }));
      expect(h.deleteMutate).toHaveBeenCalledWith('survey-1', expect.objectContaining({ onSuccess: expect.any(Function) }));

      act(() => h.deleteMutate.mock.calls[0][1].onSuccess(undefined));
      expect(onSelectSurvey).toHaveBeenCalledWith(null);
    });

    it('Cancel in the delete dialog does not call deleteSurvey.mutate', () => {
      const survey = makeSurvey();
      h.surveysData = [survey];
      renderBar({ selectedSurveyId: survey.id });

      fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(h.deleteMutate).not.toHaveBeenCalled();
      expect(screen.queryByText('Delete this survey?')).not.toBeInTheDocument();
    });
  });
});
