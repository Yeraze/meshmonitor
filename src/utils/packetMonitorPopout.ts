/** Open the standalone Packet Monitor window (#6262). `sourceId` selects a MeshCore source's monitor. */
export function buildPacketMonitorPopoutUrl(sourceId?: string | null): string {
  const baseHref = document.querySelector('base')?.getAttribute('href') || '/';
  const basename = baseHref === '/' ? '' : baseHref.replace(/\/$/, '');
  const query = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
  return `${basename}/packet-monitor${query}`;
}

export function openPacketMonitorPopout(sourceId?: string | null): void {
  try {
    window.open(buildPacketMonitorPopoutUrl(sourceId), '_blank', 'width=1200,height=800');
  } catch (error) {
    console.error('Failed to open pop-out window:', error);
  }
}
