import { useEffect, useState } from 'react';
import type { DecodedMcoImage } from '../../utils/mcoImage/types.js';
import { getLoadedMcoCodec, loadMcoCodec } from './loadMcoCodec.js';

export type McoDecodeState =
  | { status: 'loading' }
  | { status: 'ready'; image: DecodedMcoImage }
  | { status: 'failed' };

function decodeSync(payload: string): McoDecodeState | null {
  const codec = getLoadedMcoCodec();
  if (!codec) return null;
  const image = codec.decodeMcoImageText(payload);
  return image ? { status: 'ready', image } : { status: 'failed' };
}

export function useMcoImageDecode(payload: string): McoDecodeState {
  const [state, setState] = useState<{ payload: string; value: McoDecodeState }>(() => ({
    payload,
    value: decodeSync(payload) ?? { status: 'loading' },
  }));

  useEffect(() => {
    let cancelled = false;
    const sync = decodeSync(payload);
    if (sync) {
      setState({ payload, value: sync });
      return;
    }
    setState({ payload, value: { status: 'loading' } });
    loadMcoCodec().then(
      (codec) => {
        if (cancelled) return;
        const image = codec.decodeMcoImageText(payload);
        setState({ payload, value: image ? { status: 'ready', image } : { status: 'failed' } });
      },
      () => {
        if (!cancelled) setState({ payload, value: { status: 'failed' } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [payload]);

  // A stale state from the previous payload must not render for one frame.
  return state.payload === payload ? state.value : (decodeSync(payload) ?? { status: 'loading' });
}
