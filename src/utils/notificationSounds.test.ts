/**
 * @vitest-environment jsdom
 *
 * Unit tests for the notification sound library: the bundled catalogue, the
 * per-channel localStorage persistence, and the Web Audio synthesis wiring.
 *
 * Audio playback cannot actually be heard in a headless test, so playback is
 * verified deterministically by injecting a fake AudioContext and asserting
 * that the correct oscillators (waveform + frequency) are created and that
 * start()/stop() are scheduled. This proves the right sound is selected and
 * `play` is invoked per channel without needing speakers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NOTIFICATION_SOUNDS,
  DEFAULT_SOUND_ID,
  SILENT_SOUND_ID,
  getSoundById,
  getChannelSoundId,
  setChannelSoundId,
  playSound,
  playChannelSound,
} from './notificationSounds';

// ---------------------------------------------------------------------------
// Fake Web Audio API
// ---------------------------------------------------------------------------

interface FakeOscillator {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface FakeGain {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

function makeFakeContext(state: 'suspended' | 'running' | 'closed' = 'running') {
  const oscillators: FakeOscillator[] = [];
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    resume: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn((): FakeOscillator => {
      const osc: FakeOscillator = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(
      (): FakeGain => ({
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      })
    ),
  };
  return { ctx: ctx as unknown as AudioContext, oscillators };
}

describe('notificationSounds catalogue', () => {
  it('exposes a mix of standard and fun sounds', () => {
    const standard = NOTIFICATION_SOUNDS.filter(s => s.category === 'standard');
    const fun = NOTIFICATION_SOUNDS.filter(s => s.category === 'fun');
    expect(standard.length).toBeGreaterThanOrEqual(3);
    expect(fun.length).toBeGreaterThanOrEqual(3);
    // 6-9 sounds total per the design brief.
    expect(NOTIFICATION_SOUNDS.length).toBeGreaterThanOrEqual(6);
    expect(NOTIFICATION_SOUNDS.length).toBeLessThanOrEqual(9);
  });

  it('has unique ids and at least one tone step each', () => {
    const ids = NOTIFICATION_SOUNDS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sound of NOTIFICATION_SOUNDS) {
      expect(sound.steps.length).toBeGreaterThan(0);
      for (const step of sound.steps) {
        expect(step.freq).toBeGreaterThan(0);
        expect(step.duration).toBeGreaterThan(0);
        expect(step.gain).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every sound short (well under a second)', () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      const end = Math.max(...sound.steps.map(s => s.start + s.duration));
      expect(end).toBeLessThan(0.9);
    }
  });

  it('default sound exists and reproduces the original 800Hz sine ding', () => {
    const def = getSoundById(DEFAULT_SOUND_ID);
    expect(def).toBeDefined();
    expect(def!.steps).toHaveLength(1);
    expect(def!.steps[0].type).toBe('sine');
    expect(def!.steps[0].freq).toBe(800);
  });

  it('getSoundById returns undefined for unknown and silent ids', () => {
    expect(getSoundById('does-not-exist')).toBeUndefined();
    expect(getSoundById(SILENT_SOUND_ID)).toBeUndefined();
  });
});

describe('per-channel persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the default sound when nothing is stored', () => {
    expect(getChannelSoundId(0)).toBe(DEFAULT_SOUND_ID);
    expect(getChannelSoundId(3)).toBe(DEFAULT_SOUND_ID);
  });

  it('round-trips a stored selection per channel', () => {
    setChannelSoundId(0, 'coin');
    setChannelSoundId(1, 'soft-chime');
    expect(getChannelSoundId(0)).toBe('coin');
    expect(getChannelSoundId(1)).toBe('soft-chime');
    // Untouched channel still defaults.
    expect(getChannelSoundId(2)).toBe(DEFAULT_SOUND_ID);
  });

  it('persists the silent selection', () => {
    setChannelSoundId(4, SILENT_SOUND_ID);
    expect(getChannelSoundId(4)).toBe(SILENT_SOUND_ID);
  });

  it('supports the DM pseudo-channel id (-1)', () => {
    setChannelSoundId(-1, 'ping');
    expect(getChannelSoundId(-1)).toBe('ping');
  });

  it('falls back to default for a stale/unknown stored id', () => {
    localStorage.setItem('channelNotificationSound:0', 'removed-sound');
    expect(getChannelSoundId(0)).toBe(DEFAULT_SOUND_ID);
  });

  it('keeps selections independent per source', () => {
    setChannelSoundId(0, 'coin', 'srcA');
    setChannelSoundId(0, 'boop', 'srcB');
    expect(getChannelSoundId(0, 'srcA')).toBe('coin');
    expect(getChannelSoundId(0, 'srcB')).toBe('boop');
    // A third, untouched source still defaults.
    expect(getChannelSoundId(0, 'srcC')).toBe(DEFAULT_SOUND_ID);
  });

  it('inherits a legacy un-scoped selection until the source is customized', () => {
    // Selection made before per-source scoping existed (no sourceId segment).
    setChannelSoundId(1, 'ping');
    // Any source inherits it until it sets its own value.
    expect(getChannelSoundId(1, 'srcA')).toBe('ping');
    setChannelSoundId(1, 'arpeggio', 'srcA');
    expect(getChannelSoundId(1, 'srcA')).toBe('arpeggio');
    // The legacy/global value is untouched and other sources still inherit it.
    expect(getChannelSoundId(1)).toBe('ping');
    expect(getChannelSoundId(1, 'srcB')).toBe('ping');
  });
});

describe('playSound wiring', () => {
  it('schedules an oscillator per tone step with the right waveform/frequency', () => {
    const { ctx, oscillators } = makeFakeContext();
    const arp = getSoundById('arpeggio')!;
    const played = playSound('arpeggio', ctx);

    expect(played).toBe(true);
    expect(oscillators).toHaveLength(arp.steps.length);
    arp.steps.forEach((step, i) => {
      expect(oscillators[i].type).toBe(step.type);
      expect(oscillators[i].frequency.value).toBe(step.freq);
      expect(oscillators[i].start).toHaveBeenCalledOnce();
      expect(oscillators[i].stop).toHaveBeenCalledOnce();
    });
  });

  it('resumes a suspended context (autoplay policy)', () => {
    const { ctx } = makeFakeContext('suspended');
    playSound('classic-ding', ctx);
    expect((ctx as unknown as { resume: ReturnType<typeof vi.fn> }).resume).toHaveBeenCalled();
  });

  it('no-ops for the silent sentinel without creating oscillators', () => {
    const { ctx, oscillators } = makeFakeContext();
    expect(playSound(SILENT_SOUND_ID, ctx)).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it('no-ops for an unknown sound id', () => {
    const { ctx, oscillators } = makeFakeContext();
    expect(playSound('nope', ctx)).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it('does not close a caller-supplied context', () => {
    const { ctx } = makeFakeContext();
    playSound('classic-ding', ctx);
    expect((ctx as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
});

describe('playChannelSound', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('plays the channel-configured sound', () => {
    setChannelSoundId(0, 'coin');
    setChannelSoundId(1, 'boop');

    const a = makeFakeContext();
    playChannelSound(0, null, a.ctx);
    expect(a.oscillators[0].frequency.value).toBe(getSoundById('coin')!.steps[0].freq);

    const b = makeFakeContext();
    playChannelSound(1, null, b.ctx);
    expect(b.oscillators[0].frequency.value).toBe(getSoundById('boop')!.steps[0].freq);
  });

  it('a channel set to silent plays nothing', () => {
    setChannelSoundId(2, SILENT_SOUND_ID);
    const { ctx, oscillators } = makeFakeContext();
    expect(playChannelSound(2, null, ctx)).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it('an unconfigured channel plays the default sound', () => {
    const { ctx, oscillators } = makeFakeContext();
    expect(playChannelSound(7, null, ctx)).toBe(true);
    expect(oscillators[0].frequency.value).toBe(getSoundById(DEFAULT_SOUND_ID)!.steps[0].freq);
  });

  it('plays the source-scoped sound when a sourceId is given', () => {
    setChannelSoundId(0, 'coin', 'srcA');
    setChannelSoundId(0, 'boop', 'srcB');

    const a = makeFakeContext();
    playChannelSound(0, 'srcA', a.ctx);
    expect(a.oscillators[0].frequency.value).toBe(getSoundById('coin')!.steps[0].freq);

    const b = makeFakeContext();
    playChannelSound(0, 'srcB', b.ctx);
    expect(b.oscillators[0].frequency.value).toBe(getSoundById('boop')!.steps[0].freq);
  });
});
