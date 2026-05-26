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
  /** Run a command exactly as if the user had typed it into the input
   *  and pressed Send: the command lands in the transcript as a sent
   *  line, the reply / error lands as a reply / error line, history is
   *  updated. Used by sibling forms (e.g. ACL manager) so their output
   *  shares one transcript with free-typed commands. */
  runCommand: (command: string, opts?: { confirm?: boolean }) => Promise<void>;
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
  // Transcript is restored from sessionStorage on mount via the targetId
  // effect below, so a page refresh in the middle of a session doesn't
  // wipe the user's context. The initial state stays [] and the effect
  // overwrites it with whatever's saved for the current target.
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState<null | { command: string; typedName: string }>(null);
  // Ref on the scrollable transcript container itself (not a sentinel
   // inside it). Auto-scroll updates `scrollTop` directly on this element
   // so the scroll stays confined to the transcript pane — `scrollIntoView`
   // also drags outer scrollable ancestors (now the DM right pane after
   // #3205) which makes the whole page jump on every Send.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently near the bottom of the transcript.
  // If they've scrolled up to read history we leave their position alone
  // when new lines arrive — the existing scroll position is more useful
  // than auto-scrolling back to the latest output.
  const userAtBottomRef = useRef(true);

  // Hard cap on persisted transcript size. Generous enough for a long
  // working session; tight enough that worst-case sessionStorage doesn't
  // blow up. When the buffer overflows we drop the oldest entries.
  const TRANSCRIPT_MAX = 200;
  const storageKeyFor = (id: string) => `meshcore-cli-transcript:${id}`;

  // Command history — ↑/↓ in the input row cycle through previously-sent
  // commands. Cap at 50 to keep the buffer bounded; oldest entries are
  // dropped when full. History is scoped to the component instance (not
  // per-target) so a user can repeat the same command across different
  // contacts without retyping. `draft` preserves an in-progress command
  // when the user starts navigating history, so ArrowDown past the end
  // restores what they were typing.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');
  const HISTORY_MAX = 50;

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    if (userAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

  // Restore transcript when the target changes. Each target gets its own
  // sessionStorage slot so switching contacts doesn't bleed one history
  // into another. On any restore failure (corrupt JSON, quota error,
  // sessionStorage unavailable) silently fall back to an empty transcript
  // — a non-fatal annoyance is much better than a thrown render.
  useEffect(() => {
    let restored: TranscriptEntry[] = [];
    try {
      const raw = sessionStorage.getItem(storageKeyFor(targetId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) restored = parsed as TranscriptEntry[];
      }
    } catch {
      // sessionStorage may be unavailable (private mode, quota, server-
      // side render). Treat as "nothing saved" and move on.
    }
    setTranscript(restored);
    setCommand('');
    setDangerConfirm(null);
    userAtBottomRef.current = true;
  }, [targetId]);

  // Persist on every transcript change. Cap at TRANSCRIPT_MAX so a long
  // session can't fill sessionStorage. Swallow quota errors — the
  // in-memory transcript is the source of truth; persistence is a nicety.
  useEffect(() => {
    try {
      const slice = transcript.length > TRANSCRIPT_MAX
        ? transcript.slice(transcript.length - TRANSCRIPT_MAX)
        : transcript;
      sessionStorage.setItem(storageKeyFor(targetId), JSON.stringify(slice));
    } catch {
      // ignore (private mode / quota / SSR)
    }
  }, [transcript, targetId]);

  const appendTranscript = useCallback((entry: Omit<TranscriptEntry, 'id' | 'ts'>) => {
    setTranscript((prev) => [...prev, { id: nextId(), ts: Date.now(), ...entry }]);
  }, []);

  const runAndLog = useCallback(async (cmd: string, opts?: { confirm?: boolean }) => {
    if (sending) return;
    setSending(true);
    appendTranscript({ kind: 'sent', text: cmd });
    setCommand('');
    // Push to history. Skip duplicates of the most recent entry so
    // hammering Send on the same command doesn't bloat the buffer.
    const prev = historyRef.current;
    if (prev[prev.length - 1] !== cmd) {
      prev.push(cmd);
      if (prev.length > HISTORY_MAX) prev.shift();
    }
    historyIndexRef.current = null;
    draftRef.current = '';
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

  useImperativeHandle(ref, () => ({
    appendInfo: (text: string) => appendTranscript({ kind: 'info', text }),
    clear: () => {
      setTranscript([]);
      try {
        sessionStorage.removeItem(storageKeyFor(targetId));
      } catch {
        // ignore — in-memory clear is what matters
      }
    },
    runCommand: (cmd: string, opts?: { confirm?: boolean }) => runAndLog(cmd, opts),
  }), [appendTranscript, runAndLog]);

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

      <div
        ref={transcriptRef}
        className="mrc-transcript"
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          userAtBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
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
          onChange={(e) => {
            setCommand(e.target.value);
            // User started typing fresh — drop the history cursor.
            if (historyIndexRef.current !== null) {
              historyIndexRef.current = null;
              draftRef.current = '';
            }
          }}
          onKeyDown={(e) => {
            // History navigation. Only when not modified by Ctrl/Alt/Meta
            // so we don't fight the browser's own shortcuts.
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            const hist = historyRef.current;
            if (hist.length === 0) return;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (historyIndexRef.current === null) {
                // Save what the user was typing before we hijack the input.
                draftRef.current = command;
                historyIndexRef.current = hist.length - 1;
              } else if (historyIndexRef.current > 0) {
                historyIndexRef.current -= 1;
              }
              setCommand(hist[historyIndexRef.current]);
            } else if (e.key === 'ArrowDown') {
              if (historyIndexRef.current === null) return;
              e.preventDefault();
              if (historyIndexRef.current < hist.length - 1) {
                historyIndexRef.current += 1;
                setCommand(hist[historyIndexRef.current]);
              } else {
                // Moved past the newest entry — restore the saved draft.
                historyIndexRef.current = null;
                setCommand(draftRef.current);
                draftRef.current = '';
              }
            }
          }}
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
