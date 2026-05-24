/**
 * CliConsoleBody — shared MeshCore CLI surface.
 *
 * Owns the transcript, command input, quick-action button row, and the
 * danger-confirm modal. Used by both `MeshCoreRemoteConsole` (where the
 * parent layers login + credential capability on top) and
 * `MeshCoreLocalConsole` (where the parent layers nothing — the local
 * node has no admin password).
 *
 * The parent passes:
 *  - `runCommand(text, { confirm? })` — actually sends to the wire.
 *  - `actionCatalog` — quick-action buttons. Danger items route through
 *    the typed-name confirmation modal.
 *  - `targetName` — the literal string the user types to unlock danger
 *    commands. Remote console uses the contact name; local console uses
 *    the device name (or "this device" when none is set).
 *  - `disabled` — disables the input and action buttons (e.g. remote
 *    console passes `!loggedIn`).
 *
 * The parent can also push info lines into the transcript via the
 * imperative ref handle (used by remote console to log
 * "Logged in with saved password" after auto-login).
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import './MeshCoreRemoteConsole.css';

export interface ActionCommand {
  key: string;
  labelKey: string;
  defaultLabel: string;
  command: string;
  danger?: boolean;
}

/** Server-enforced regex for danger commands. Mirrored from
 *  meshcoreRoutes.ts:DANGER_COMMAND_PATTERN; keep in sync. */
export const DANGER_COMMAND_PATTERN = /(reboot|erase|clkreboot|factory)/i;

export type CliRunResult =
  | { ok: true; reply: string; elapsedMs?: number }
  | { ok: false; error: string; code?: string };

export interface CliConsoleBodyHandle {
  /** Append an info-style line to the transcript (e.g. "Logged in"). */
  appendInfo: (text: string) => void;
  /** Clear the transcript. */
  clear: () => void;
}

interface TranscriptEntry {
  id: string;
  kind: 'sent' | 'reply' | 'error' | 'info';
  text: string;
  ts: number;
}

interface CliConsoleBodyProps {
  /** Stable identifier for the target — when this changes, transcript
   *  resets. Remote uses publicKey; local uses sourceId. */
  targetId: string;
  /** Literal string the user must type into the danger-confirm modal
   *  to unlock the action. */
  targetName: string;
  /** Send the command. The console handles transcript bookkeeping. */
  runCommand: (command: string, opts?: { confirm?: boolean }) => Promise<CliRunResult>;
  /** Quick-action buttons. Empty array → no row. */
  actionCatalog: ActionCommand[];
  /** When true, the input row and action buttons are disabled. */
  disabled?: boolean;
  /** Placeholder for the input row when disabled. */
  disabledPlaceholder?: string;
  /** Placeholder for the input row when enabled. */
  placeholder?: string;
  /** Empty-transcript text when disabled. */
  emptyTextDisabled?: string;
  /** Empty-transcript text when enabled. */
  emptyTextEnabled?: string;
}

const nextId = (() => {
  let counter = 0;
  return () => `${Date.now()}-${counter++}`;
})();

export const CliConsoleBody = forwardRef<CliConsoleBodyHandle, CliConsoleBodyProps>(function CliConsoleBody(
  {
    targetId,
    targetName,
    runCommand,
    actionCatalog,
    disabled = false,
    disabledPlaceholder,
    placeholder,
    emptyTextDisabled,
    emptyTextEnabled,
  },
  ref,
) {
  const { t } = useTranslation();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState<null | { command: string; typedName: string }>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript]);

  // Reset transcript whenever the target changes — a stale transcript
  // labelled with a different target would be confusing.
  useEffect(() => {
    setTranscript([]);
    setCommand('');
    setDangerConfirm(null);
  }, [targetId]);

  const appendTranscript = useCallback((entry: Omit<TranscriptEntry, 'id' | 'ts'>) => {
    setTranscript((prev) => [...prev, { id: nextId(), ts: Date.now(), ...entry }]);
  }, []);

  useImperativeHandle(ref, () => ({
    appendInfo: (text: string) => appendTranscript({ kind: 'info', text }),
    clear: () => setTranscript([]),
  }), [appendTranscript]);

  const runAndLog = useCallback(async (cmd: string, opts?: { confirm?: boolean }) => {
    if (sending) return;
    setSending(true);
    appendTranscript({ kind: 'sent', text: cmd });
    setCommand('');
    const result = await runCommand(cmd, opts);
    setSending(false);
    if (result.ok) {
      appendTranscript({ kind: 'reply', text: result.reply || '(empty reply)' });
    } else {
      const hint =
        result.code === 'CLI_TIMEOUT'
          ? t(
              'meshcore.remoteConsole.timeout_hint',
              ' — the remote did not reply. Path may be stale, or the admin session may have expired.',
            )
          : '';
      appendTranscript({ kind: 'error', text: `${result.error}${hint}` });
    }
  }, [appendTranscript, runCommand, sending, t]);

  const handleSend = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || sending) return;
    if (DANGER_COMMAND_PATTERN.test(trimmed)) {
      setDangerConfirm({ command: trimmed, typedName: '' });
      return;
    }
    await runAndLog(trimmed);
  }, [command, runAndLog, sending]);

  const handleActionClick = useCallback((action: ActionCommand) => {
    if (action.danger) {
      setDangerConfirm({ command: action.command, typedName: '' });
      return;
    }
    setCommand(action.command);
  }, []);

  const handleDangerConfirm = useCallback(async () => {
    if (!dangerConfirm) return;
    const cmd = dangerConfirm.command;
    setDangerConfirm(null);
    await runAndLog(cmd, { confirm: true });
  }, [dangerConfirm, runAndLog]);

  return (
    <>
      {actionCatalog.length > 0 && (
        <div className="mrc-quick-actions" role="group" aria-label={t('meshcore.remoteConsole.quick_actions', 'Quick actions')}>
          {actionCatalog.map((action) => (
            <button
              key={action.key}
              type="button"
              className={action.danger ? 'mrc-btn-danger' : 'mrc-btn-quick'}
              onClick={() => handleActionClick(action)}
              disabled={disabled || sending}
              title={action.command}
            >
              {t(action.labelKey, action.defaultLabel)}
            </button>
          ))}
        </div>
      )}

      <div className="mrc-transcript" role="log" aria-live="polite">
        {transcript.length === 0 ? (
          <p className="mrc-transcript-empty">
            {disabled
              ? emptyTextDisabled ?? t('meshcore.remoteConsole.empty_logged_out', 'Log in to begin sending commands.')
              : emptyTextEnabled ?? t('meshcore.remoteConsole.empty_logged_in', 'Type a command below and press Send.')}
          </p>
        ) : (
          transcript.map((entry) => (
            <div key={entry.id} className={`mrc-line mrc-line-${entry.kind}`}>
              <span className="mrc-line-prefix">{prefixFor(entry.kind)}</span>
              <pre className="mrc-line-text">{entry.text}</pre>
            </div>
          ))
        )}
        <div ref={transcriptEndRef} />
      </div>

      <form
        className="mrc-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={
            disabled
              ? disabledPlaceholder ?? t('meshcore.remoteConsole.command_placeholder_logged_out', 'Log in first')
              : placeholder ?? t('meshcore.remoteConsole.command_placeholder', 'Type a command (e.g. ver, stats, neighbors)')
          }
          disabled={disabled || sending}
          className="mrc-input"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={disabled || sending || command.trim().length === 0}
          className="mrc-btn-primary"
        >
          {sending
            ? t('meshcore.remoteConsole.sending', 'Sending…')
            : t('meshcore.remoteConsole.send', 'Send')}
        </button>
      </form>

      {dangerConfirm && (
        <div
          className="mrc-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mrc-danger-title"
          onClick={() => setDangerConfirm(null)}
        >
          <div className="mrc-modal mrc-modal-danger" onClick={(e) => e.stopPropagation()}>
            <h4 id="mrc-danger-title">
              {t('meshcore.remoteConsole.danger_modal_title', 'Confirm destructive command')}
            </h4>
            <p className="mrc-modal-body">
              {t(
                'meshcore.remoteConsole.danger_modal_body',
                'You are about to send "{{command}}" to {{name}}. This action may interrupt the remote node. Type the contact name to confirm:',
                { command: dangerConfirm.command, name: targetName },
              )}
            </p>
            <input
              type="text"
              value={dangerConfirm.typedName}
              onChange={(e) => setDangerConfirm({ ...dangerConfirm, typedName: e.target.value })}
              className="mrc-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={targetName}
            />
            <div className="mrc-modal-actions">
              <button
                type="button"
                className="mrc-btn-secondary"
                onClick={() => setDangerConfirm(null)}
              >
                {t('meshcore.remoteConsole.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="mrc-btn-danger"
                onClick={() => void handleDangerConfirm()}
                disabled={dangerConfirm.typedName !== targetName}
              >
                {t('meshcore.remoteConsole.danger_confirm', 'Send {{command}}', { command: dangerConfirm.command })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

function prefixFor(kind: TranscriptEntry['kind']): string {
  switch (kind) {
    case 'sent': return '>';
    case 'reply': return '<';
    case 'error': return '!';
    case 'info': return '*';
  }
}
