/**
 * CoverageSurveyBar — saved-survey controls for the Coverage Report
 * (#5277 P4b WP3, COVERAGE_P4_SPEC.md §2b.7). A self-contained section: it
 * owns the survey list query and the four write mutations (create/update/
 * stop/delete) internally, the same shape as `CoverageMqttRecordingSection`.
 * `CoverageReport` stays the source of truth for sender/window/receiver
 * state — this component only ever proposes a survey to apply, via
 * `onSelectSurvey`, mirroring how `CoverageReceiverFilter` only ever
 * proposes a new deselected set via `onChange`.
 *
 * U2 (spec §5): anonymous users get no survey controls at all — the whole
 * bar renders nothing when unauthenticated (the survey LIST is also empty
 * for anonymous server-side, so there would be nothing to pick even if the
 * picker rendered). Write actions beyond that are further gated by
 * `canEdit` per survey (creator or admin), independent of the anonymous
 * check.
 *
 * No new mesh traffic: every mutation here writes one DB row server-side
 * (spec §0) — this component never talks to a node.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import Modal from '../common/Modal';
import SearchableSelect, { type SearchableSelectOption } from '../common/SearchableSelect';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import {
  useCoverageSurveys,
  useCreateSurvey,
  useUpdateSurvey,
  useStopSurvey,
  useDeleteSurvey,
} from '../../hooks/useCoverageSurveys';
import { useNow } from '../../hooks/useNow';
import { COVERAGE_SURVEY_LIVE_MAX_MS, COVERAGE_SURVEY_MAX_RANGE_MS } from '../../utils/coverage';
import { formatDuration } from '../../utils/telemetryFormat';
import {
  defaultSurveyName,
  mapSurveyErrorMessage,
  parseIntervalSecInput,
  sortSurveysNewestFirst,
} from './coverageSurveyBar.helpers';
import type { CoverageSurveyDto } from '../../types/coverage';
import styles from './CoverageSurveyBar.module.css';

export interface CoverageSurveyBarProps {
  /** Currently selected sender in the report (`''` = All). Start/Save need a real sender. */
  senderId: string;
  /** Best display label for `senderId` (name, or a formatted id) — used for the default survey name. */
  senderLabel: string;
  /** The report's current resolved window — what Save-as-survey stores as `startAt`/`endAt`. */
  currentSinceMs: number;
  currentUntilMs: number;
  /** Encoded receiver-filter wire string for the report's CURRENT receiver
   *  selection, or `null` for "every receiver" — what Save-as-survey stores. */
  currentReceiversEncoded: string | null;
  /** The survey currently applied to the report, if any. */
  selectedSurveyId: string | null;
  /** Called when the user picks a different survey ("No survey" -> `null`),
   *  and again after Start/Save/Stop succeed so the report re-applies the
   *  (possibly updated) survey. */
  onSelectSurvey: (survey: CoverageSurveyDto | null) => void;
}

type ModalKind = 'start' | 'save' | 'edit' | 'delete' | null;

/** How often the live badge's elapsed-time label re-renders. Display-only —
 *  this never touches a query key or triggers a fetch (see `useNow`'s doc
 *  comment). 30 s matches the granularity `formatDuration` actually shows
 *  (its smallest unit is minutes), so a faster tick would repaint more
 *  often than the label could ever visibly change. */
const SURVEY_LIVE_TICK_MS = 30_000;

export const CoverageSurveyBar: React.FC<CoverageSurveyBarProps> = ({
  senderId,
  senderLabel,
  currentSinceMs,
  currentUntilMs,
  currentReceiversEncoded,
  selectedSurveyId,
  onSelectSurvey,
}) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { showToast } = useToast();

  const surveysQuery = useCoverageSurveys();
  const createSurvey = useCreateSurvey();
  const updateSurvey = useUpdateSurvey();
  const stopSurvey = useStopSurvey();
  const deleteSurvey = useDeleteSurvey();

  const [modal, setModal] = useState<ModalKind>(null);
  const [formName, setFormName] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formInterval, setFormInterval] = useState('');

  const surveys = useMemo(() => sortSurveysNewestFirst(surveysQuery.data ?? []), [surveysQuery.data]);
  const selectedSurvey = useMemo(
    () => surveys.find((s) => s.id === selectedSurveyId) ?? null,
    [surveys, selectedSurveyId],
  );

  // Ticks the live badge's "elapsed" label (#5277 review follow-up, PR
  // #5353) — a bare `Date.now()` read at render only updates when
  // something ELSE re-renders this component, so the label froze. Only
  // ticks while a live survey is actually selected and shown; the
  // auto-end timestamp below is a fixed target time, not something that
  // needs a live clock. Display-only: `now` never reaches a query key.
  const now = useNow(SURVEY_LIVE_TICK_MS, Boolean(selectedSurvey?.isLive));

  const surveyOptions = useMemo<SearchableSelectOption[]>(
    () =>
      surveys.map((s) => ({
        value: s.id,
        label: s.isLive ? t('analysis.coverage.survey_option_live', '{{name}} (live)', { name: s.name }) : s.name,
        keywords: [s.senderId, s.notes ?? ''].join(' '),
      })),
    [surveys, t],
  );

  const closeModal = useCallback(() => setModal(null), []);

  const openStart = useCallback(() => {
    setFormName(defaultSurveyName(senderLabel, Date.now()));
    setFormNotes('');
    setModal('start');
  }, [senderLabel]);

  const openSave = useCallback(() => {
    setFormName(defaultSurveyName(senderLabel, Date.now()));
    setFormNotes('');
    setModal('save');
  }, [senderLabel]);

  const openEdit = useCallback(() => {
    if (!selectedSurvey) return;
    setFormName(selectedSurvey.name);
    setFormNotes(selectedSurvey.notes ?? '');
    setFormInterval(selectedSurvey.intervalSec != null ? String(selectedSurvey.intervalSec) : '');
    setModal('edit');
  }, [selectedSurvey]);

  const openDelete = useCallback(() => setModal('delete'), []);

  const handlePick = useCallback(
    (value: string) => {
      if (!value) {
        onSelectSurvey(null);
        return;
      }
      const survey = surveys.find((s) => s.id === value);
      if (survey) onSelectSurvey(survey);
    },
    [surveys, onSelectSurvey],
  );

  const handleConfirmStart = useCallback(() => {
    if (!senderId) return;
    createSurvey.mutate(
      {
        name: formName.trim() || defaultSurveyName(senderLabel, Date.now()),
        senderId,
        live: true,
        receivers: currentReceiversEncoded,
        notes: formNotes.trim() || null,
      },
      {
        onSuccess: (survey) => {
          setModal(null);
          onSelectSurvey(survey);
          showToast(t('analysis.coverage.survey_started_toast', 'Survey started.'), 'success');
        },
        onError: (error) => showToast(mapSurveyErrorMessage(t, error), 'error'),
      },
    );
  }, [senderId, formName, formNotes, senderLabel, currentReceiversEncoded, createSurvey, onSelectSurvey, showToast, t]);

  const handleConfirmSave = useCallback(() => {
    if (!senderId) return;
    createSurvey.mutate(
      {
        name: formName.trim() || defaultSurveyName(senderLabel, Date.now()),
        senderId,
        startAt: currentSinceMs,
        endAt: currentUntilMs,
        receivers: currentReceiversEncoded,
        notes: formNotes.trim() || null,
      },
      {
        onSuccess: (survey) => {
          setModal(null);
          onSelectSurvey(survey);
          showToast(t('analysis.coverage.survey_saved_toast', 'Survey saved.'), 'success');
        },
        onError: (error) => showToast(mapSurveyErrorMessage(t, error), 'error'),
      },
    );
  }, [
    senderId,
    formName,
    formNotes,
    senderLabel,
    currentSinceMs,
    currentUntilMs,
    currentReceiversEncoded,
    createSurvey,
    onSelectSurvey,
    showToast,
    t,
  ]);

  const intervalValue = parseIntervalSecInput(formInterval);
  const intervalIsInvalid = intervalValue === undefined;

  const handleConfirmEdit = useCallback(() => {
    if (!selectedSurvey || intervalIsInvalid) return;
    updateSurvey.mutate(
      {
        id: selectedSurvey.id,
        body: {
          name: formName.trim() || selectedSurvey.name,
          notes: formNotes.trim() || null,
          intervalSec: intervalValue,
        },
      },
      {
        onSuccess: (survey) => {
          setModal(null);
          onSelectSurvey(survey);
          showToast(t('analysis.coverage.survey_updated_toast', 'Survey updated.'), 'success');
        },
        onError: (error) => showToast(mapSurveyErrorMessage(t, error), 'error'),
      },
    );
  }, [selectedSurvey, intervalIsInvalid, intervalValue, formName, formNotes, updateSurvey, onSelectSurvey, showToast, t]);

  const handleStop = useCallback(() => {
    if (!selectedSurvey) return;
    stopSurvey.mutate(selectedSurvey.id, {
      onSuccess: (survey) => {
        onSelectSurvey(survey);
        showToast(t('analysis.coverage.survey_stopped_toast', 'Survey stopped.'), 'success');
      },
      onError: (error) => showToast(mapSurveyErrorMessage(t, error), 'error'),
    });
  }, [selectedSurvey, stopSurvey, onSelectSurvey, showToast, t]);

  const handleConfirmDelete = useCallback(() => {
    if (!selectedSurvey) return;
    deleteSurvey.mutate(selectedSurvey.id, {
      onSuccess: () => {
        setModal(null);
        onSelectSurvey(null);
        showToast(t('analysis.coverage.survey_deleted_toast', 'Survey deleted.'), 'success');
      },
      onError: (error) => showToast(mapSurveyErrorMessage(t, error), 'error'),
    });
  }, [selectedSurvey, deleteSurvey, onSelectSurvey, showToast, t]);

  if (!authStatus?.authenticated) {
    return null;
  }

  const noSender = senderId === '';
  const windowTooLong = currentUntilMs - currentSinceMs > COVERAGE_SURVEY_MAX_RANGE_MS;
  const canEdit = selectedSurvey?.canEdit ?? false;

  return (
    <div className={styles.wrap} data-testid="coverage-survey-bar">
      <div className={`reports-controls__field ${styles.pickerField}`}>
        <span>{t('analysis.coverage.survey_label', 'Survey')}</span>
        <SearchableSelect
          value={selectedSurveyId ?? ''}
          onChange={handlePick}
          options={surveyOptions}
          emptyLabel={t('analysis.coverage.survey_none', 'No survey')}
          placeholder={t('analysis.coverage.survey_search_placeholder', 'Search surveys')}
          noMatchesText={t('analysis.coverage.survey_no_matches', 'No matching surveys')}
          ariaLabel={t('analysis.coverage.survey_label', 'Survey')}
        />
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className="reports-btn reports-btn--ghost"
          onClick={openStart}
          disabled={noSender}
          title={noSender ? t('analysis.coverage.survey_needs_sender', 'Pick a sender first.') : undefined}
        >
          <UiIcon name="play" size={14} />
          {t('analysis.coverage.survey_start', 'Start survey')}
        </button>

        <button
          type="button"
          className="reports-btn reports-btn--ghost"
          onClick={openSave}
          disabled={noSender || windowTooLong}
          title={
            noSender
              ? t('analysis.coverage.survey_needs_sender', 'Pick a sender first.')
              : windowTooLong
                ? t('analysis.coverage.survey_window_too_long', 'The current window is longer than 7 days.')
                : undefined
          }
        >
          <UiIcon name="save" size={14} />
          {t('analysis.coverage.survey_save', 'Save as survey')}
        </button>

        {selectedSurvey?.isLive && canEdit && (
          <button type="button" className="reports-btn reports-btn--ghost" onClick={handleStop}>
            <UiIcon name="pause" size={14} />
            {t('analysis.coverage.survey_stop', 'Stop survey')}
          </button>
        )}

        {selectedSurvey && canEdit && (
          <>
            <button type="button" className="reports-btn reports-btn--ghost" onClick={openEdit}>
              <UiIcon name="edit" size={14} />
              {t('analysis.coverage.survey_edit', 'Edit')}
            </button>
            <button type="button" className="reports-btn reports-btn--ghost" onClick={openDelete}>
              <UiIcon name="delete" size={14} />
              {t('analysis.coverage.survey_delete', 'Delete')}
            </button>
          </>
        )}
      </div>

      {selectedSurvey?.isLive && (
        <div className={styles.liveBadge} data-testid="coverage-survey-live-badge">
          <UiIcon name="radioSignal" size={12} className={styles.liveDot} />
          {t('analysis.coverage.survey_live_elapsed', 'Live — {{elapsed}} elapsed', {
            elapsed: formatDuration(Math.max(0, (now - selectedSurvey.startAt) / 1000)),
          })}
          <span className={styles.liveAutoEnd}>
            {t('analysis.coverage.survey_live_auto_end', 'Auto-ends at {{time}}', {
              time: new Date(selectedSurvey.startAt + COVERAGE_SURVEY_LIVE_MAX_MS).toLocaleString(),
            })}
          </span>
        </div>
      )}

      <Modal
        isOpen={modal === 'start' || modal === 'save'}
        onClose={closeModal}
        title={
          modal === 'start'
            ? t('analysis.coverage.survey_start_title', 'Start a live survey')
            : t('analysis.coverage.survey_save_title', 'Save the current range as a survey')
        }
        className={styles.formDialog}
      >
        <p className={styles.modalNote}>
          {t(
            'analysis.coverage.survey_no_send_note',
            'MeshMonitor sends nothing — set up the survey node per the guidance below the map.',
          )}
        </p>
        <label className={styles.formField}>
          <span>{t('analysis.coverage.survey_form_name', 'Name')}</span>
          <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} maxLength={120} />
        </label>
        <label className={styles.formField}>
          <span>{t('analysis.coverage.survey_form_notes', 'Notes')}</span>
          <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} maxLength={2000} rows={3} />
        </label>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={closeModal}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={modal === 'start' ? handleConfirmStart : handleConfirmSave}
            disabled={formName.trim() === '' || createSurvey.isPending}
          >
            {modal === 'start'
              ? t('analysis.coverage.survey_start', 'Start survey')
              : t('analysis.coverage.survey_save', 'Save as survey')}
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={modal === 'edit'}
        onClose={closeModal}
        title={t('analysis.coverage.survey_edit_title', 'Edit survey')}
        className={styles.formDialog}
      >
        <label className={styles.formField}>
          <span>{t('analysis.coverage.survey_form_name', 'Name')}</span>
          <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} maxLength={120} />
        </label>
        <label className={styles.formField}>
          <span>{t('analysis.coverage.survey_form_notes', 'Notes')}</span>
          <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} maxLength={2000} rows={3} />
        </label>
        <label className={styles.formField}>
          <span>{t('analysis.coverage.survey_form_interval', 'Broadcast interval (seconds)')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={formInterval}
            onChange={(e) => setFormInterval(e.target.value)}
            placeholder={t('analysis.coverage.survey_form_interval_placeholder', 'Auto-detect')}
          />
          {intervalIsInvalid && (
            <span className={styles.errorText}>
              {t('analysis.coverage.survey_form_interval_error', 'Enter a whole number of seconds, or leave blank.')}
            </span>
          )}
        </label>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={closeModal}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleConfirmEdit}
            disabled={formName.trim() === '' || intervalIsInvalid || updateSurvey.isPending}
          >
            {t('analysis.coverage.survey_save_changes', 'Save changes')}
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={modal === 'delete'}
        onClose={closeModal}
        title={t('analysis.coverage.survey_delete_title', 'Delete this survey?')}
        className={styles.formDialog}
      >
        <p className={styles.modalNote}>
          {t(
            'analysis.coverage.survey_delete_note',
            'This removes the survey. Its receptions stay recorded and fall to the normal retention sweep.',
          )}
        </p>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={closeModal}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={handleConfirmDelete}
            disabled={deleteSurvey.isPending}
          >
            {t('analysis.coverage.survey_delete', 'Delete')}
          </button>
        </div>
      </Modal>
    </div>
  );
};

export default CoverageSurveyBar;
