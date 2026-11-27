/**
 * Build the text for every nonce 0..255 and pick one of the shortest at random
 * (the nonce changes the Base91 length by at most one character).
 */
export function pickShortestNonce(
  build: (nonce: number) => string,
  rng: () => number,
): { nonce: number; text: string } {
  let best: string[] = [];
  let bestNonces: number[] = [];
  let bestLen = Infinity;
  for (let n = 0; n < 256; n++) {
    const t = build(n);
    if (t.length < bestLen) {
      bestLen = t.length;
      best = [t];
      bestNonces = [n];
    } else if (t.length === bestLen) {
      best.push(t);
      bestNonces.push(n);
    }
  }
  const k = Math.min(best.length - 1, Math.floor(rng() * best.length));
  return { nonce: bestNonces[k], text: best[k] };
}
