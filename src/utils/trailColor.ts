/**
 * Stable per-key trail colour. Shared by the Map Analysis position trails and
 * the likely-aircraft flight trails (#5364/#5365 Phase 3, D3), so the same
 * key always hashes to the same hue on every map.
 */
export function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 55%)`;
}
