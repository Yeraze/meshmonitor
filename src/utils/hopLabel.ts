/** Human label for a MeshCore path length: Unknown / Direct / N hop(s). */
export function hopCountLabel(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return 'Unknown';
  if (hops === 0) return 'Direct';
  return `${hops} hop${hops > 1 ? 's' : ''}`;
}
