/**
 * Notification sound library.
 *
 * Every sound here is synthesized at runtime from the Web Audio API using
 * oscillators and gain envelopes — there are no audio files and no third-party
 * samples, so the whole set is original and free of any licensing
 * encumbrance (it is, in effect, public-domain procedural audio). This mirrors
 * the approach the app already used for its single hard-coded "ding" and simply
 * generalizes it into a small, selectable catalogue.
 *
 * A "sound" is described declaratively as an ordered list of {@link ToneStep}s.
 * Each step is one oscillator with its own waveform, frequency, start offset,
 * duration and peak gain. `playSound` walks the steps and schedules them on a
 * single short-lived {@link AudioContext}, which is closed once the longest
 * step has finished so we never leak audio contexts.
 *
 * Per-channel selections are persisted in `localStorage`, matching how the
 * existing `enableAudioNotifications` master toggle is stored (client-local,
 * no server round-trip, no database migration).
 */

import { logger } from './logger';

/** A single scheduled oscillator within a sound. */
export interface ToneStep {
  /** Oscillator waveform. */
  type: OscillatorType;
  /** Frequency in Hz. */
  freq: number;
  /** Start offset from the beginning of the sound, in seconds. */
  start: number;
  /** How long the oscillator plays, in seconds. */
  duration: number;
  /** Peak gain (0..1) for this step's amplitude envelope. */
  gain: number;
}

/** Grouping used purely for display/ordering in the picker. */
export type SoundCategory = 'standard' | 'fun';

/** A selectable notification sound. */
export interface NotificationSound {
  /** Stable identifier persisted to localStorage. Never change these. */
  id: string;
  /** i18n-independent English label (translation handled in the UI layer). */
  label: string;
  /** Small emoji shown next to the label in the picker. */
  emoji: string;
  /** Standard vs. fun, for grouping in the picker. */
  category: SoundCategory;
  /** The oscillator steps that make up the sound. */
  steps: ToneStep[];
}

/**
 * Special selection value meaning "play nothing for this channel". Stored like
 * any other sound id but handled as a no-op by {@link playSound}.
 */
export const SILENT_SOUND_ID = 'none';

/**
 * Default sound id. `classic-ding` is a single 800Hz sine ding that reproduces
 * the app's previous hard-coded notification tone, so users who never open the
 * picker hear exactly what they heard before this feature existed.
 */
export const DEFAULT_SOUND_ID = 'classic-ding';

/**
 * The bundled catalogue. Order here is the order shown in the picker (within
 * each category). All frequencies/timings are hand-tuned to be short (well
 * under a second), pleasant and clearly distinguishable from one another.
 */
export const NOTIFICATION_SOUNDS: NotificationSound[] = [
  // ----- Standard tones -------------------------------------------------
  {
    id: 'classic-ding',
    label: 'Classic Ding',
    emoji: '🔔',
    category: 'standard',
    steps: [{ type: 'sine', freq: 800, start: 0, duration: 0.3, gain: 0.3 }],
  },
  {
    id: 'soft-chime',
    label: 'Soft Chime',
    emoji: '🎐',
    category: 'standard',
    steps: [
      { type: 'sine', freq: 660, start: 0, duration: 0.4, gain: 0.25 },
      { type: 'sine', freq: 988, start: 0.08, duration: 0.45, gain: 0.18 },
    ],
  },
  {
    id: 'classic-beep',
    label: 'Classic Beep',
    emoji: '📟',
    category: 'standard',
    steps: [{ type: 'square', freq: 1000, start: 0, duration: 0.12, gain: 0.18 }],
  },
  {
    id: 'ping',
    label: 'Ping',
    emoji: '📍',
    category: 'standard',
    steps: [
      { type: 'sine', freq: 1320, start: 0, duration: 0.06, gain: 0.25 },
      { type: 'sine', freq: 1760, start: 0.05, duration: 0.18, gain: 0.2 },
    ],
  },
  {
    id: 'marimba',
    label: 'Marimba Blip',
    emoji: '🎵',
    category: 'standard',
    steps: [
      { type: 'triangle', freq: 587, start: 0, duration: 0.18, gain: 0.3 },
      { type: 'triangle', freq: 880, start: 0.09, duration: 0.22, gain: 0.22 },
    ],
  },
  // ----- Fun tones ------------------------------------------------------
  {
    id: 'coin',
    label: '8-bit Coin',
    emoji: '🪙',
    category: 'fun',
    steps: [
      { type: 'square', freq: 988, start: 0, duration: 0.07, gain: 0.18 },
      { type: 'square', freq: 1319, start: 0.07, duration: 0.3, gain: 0.18 },
    ],
  },
  {
    id: 'arpeggio',
    label: 'Ascending Arpeggio',
    emoji: '🎶',
    category: 'fun',
    steps: [
      { type: 'sine', freq: 523, start: 0, duration: 0.12, gain: 0.22 },
      { type: 'sine', freq: 659, start: 0.1, duration: 0.12, gain: 0.22 },
      { type: 'sine', freq: 784, start: 0.2, duration: 0.12, gain: 0.22 },
      { type: 'sine', freq: 1047, start: 0.3, duration: 0.2, gain: 0.22 },
    ],
  },
  {
    id: 'boop',
    label: 'Boop',
    emoji: '👽',
    category: 'fun',
    steps: [
      { type: 'sine', freq: 440, start: 0, duration: 0.1, gain: 0.3 },
      { type: 'sine', freq: 330, start: 0.09, duration: 0.16, gain: 0.3 },
    ],
  },
  {
    id: 'radio-squelch',
    label: 'Radio Squelch',
    emoji: '📻',
    category: 'fun',
    steps: [
      { type: 'square', freq: 1800, start: 0, duration: 0.05, gain: 0.08 },
      { type: 'sawtooth', freq: 220, start: 0.04, duration: 0.1, gain: 0.12 },
      { type: 'square', freq: 1500, start: 0.13, duration: 0.05, gain: 0.08 },
    ],
  },
];

/** localStorage key prefix for per-channel selections. */
const STORAGE_PREFIX = 'channelNotificationSound:';

/**
 * Build the localStorage key for a channel id, scoped to a source when one is
 * given. Channel numbers (0–7, plus the `-1` DM pseudo-channel) collide across
 * sources, so a per-source key keeps each source's selections independent. When
 * no source is active (legacy / single-source mode) the original un-scoped key
 * is used, which also lets {@link getChannelSoundId} fall back to pre-existing
 * selections made before per-source scoping existed.
 */
function storageKey(channelId: number, sourceId?: string | null): string {
  return sourceId
    ? `${STORAGE_PREFIX}${sourceId}:${channelId}`
    : `${STORAGE_PREFIX}${channelId}`;
}

/** Look up a sound by id. Returns `undefined` for unknown ids and silence. */
export function getSoundById(id: string): NotificationSound | undefined {
  return NOTIFICATION_SOUNDS.find(s => s.id === id);
}

/**
 * The persisted sound id for a channel, scoped to `sourceId` when given.
 * Channel `-1` is used by the app for the direct-message pseudo-channel, so it
 * is a valid key here too. When a source is active but has no stored value, the
 * legacy un-scoped key is consulted so selections made before per-source
 * scoping continue to work. Falls back to {@link DEFAULT_SOUND_ID} when nothing
 * is stored or storage is unavailable.
 */
export function getChannelSoundId(channelId: number, sourceId?: string | null): string {
  try {
    let stored = localStorage.getItem(storageKey(channelId, sourceId));
    // Inherit a pre-per-source (or single-source) selection when this source
    // hasn't been customized yet.
    if (stored === null && sourceId) {
      stored = localStorage.getItem(storageKey(channelId));
    }
    if (stored === null) return DEFAULT_SOUND_ID;
    // Accept the silent sentinel or any known sound id; ignore stale/unknown
    // ids (e.g. a sound removed in a later version) and fall back to default.
    if (stored === SILENT_SOUND_ID || getSoundById(stored)) return stored;
    return DEFAULT_SOUND_ID;
  } catch {
    return DEFAULT_SOUND_ID;
  }
}

/** Persist a channel's sound selection, scoped to `sourceId` when given. */
export function setChannelSoundId(channelId: number, soundId: string, sourceId?: string | null): void {
  try {
    localStorage.setItem(storageKey(channelId, sourceId), soundId);
  } catch (error) {
    logger.debug('Could not persist channel notification sound:', error);
  }
}

/**
 * Synthesize and play a sound by id using the Web Audio API.
 *
 * No-ops (returns `false`) for the silent sentinel or an unknown id. Returns
 * `true` when playback was scheduled. Respects browser autoplay policy by
 * resuming a suspended context; callers should only invoke this in response to
 * (or after) a user gesture / granted notifications, exactly as the previous
 * single-tone implementation did.
 *
 * @param soundId  Sound to play.
 * @param ctx      Optional AudioContext (injected in tests). When omitted a new
 *                 context is created and closed after the sound finishes.
 */
export function playSound(soundId: string, ctx?: AudioContext): boolean {
  if (soundId === SILENT_SOUND_ID) return false;
  const sound = getSoundById(soundId);
  if (!sound) {
    logger.debug('🔇 Unknown notification sound id, skipping:', soundId);
    return false;
  }

  try {
    const AudioCtor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor && !ctx) {
      logger.debug('🔇 Web Audio API unavailable, skipping sound');
      return false;
    }

    const ownsContext = !ctx;
    const audioContext = ctx ?? new AudioCtor!();

    if (audioContext.state === 'suspended') {
      void audioContext.resume();
    }

    const now = audioContext.currentTime;
    let soundEnd = 0;

    for (const step of sound.steps) {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.type = step.type;
      oscillator.frequency.value = step.freq;

      const stepStart = now + step.start;
      const stepEnd = stepStart + step.duration;
      soundEnd = Math.max(soundEnd, stepEnd);

      // Quick attack, exponential decay — the same envelope shape the original
      // single "ding" used, applied per step.
      gainNode.gain.setValueAtTime(0, stepStart);
      gainNode.gain.linearRampToValueAtTime(step.gain, stepStart + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, stepEnd);

      oscillator.start(stepStart);
      oscillator.stop(stepEnd);
    }

    // Close the context once the whole sound has finished, but only if we
    // created it (an injected context is the caller's to manage).
    if (ownsContext) {
      const lifetimeMs = Math.max(0, (soundEnd - now) * 1000) + 50;
      setTimeout(() => {
        audioContext.close().catch(() => {
          /* ignore close errors */
        });
      }, lifetimeMs);
    }

    return true;
  } catch (error) {
    logger.error('❌ Failed to play notification sound:', error);
    return false;
  }
}

/**
 * Convenience: play whatever sound the given channel is configured for,
 * scoped to `sourceId` when given. Returns the result of {@link playSound}.
 */
export function playChannelSound(channelId: number, sourceId?: string | null, ctx?: AudioContext): boolean {
  return playSound(getChannelSoundId(channelId, sourceId), ctx);
}
