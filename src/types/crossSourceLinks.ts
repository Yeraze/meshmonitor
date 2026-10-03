/**
 * API contract for `/api/analysis/cross-source-links` (#5561): directional
 * "source A's radio was heard by source B" edges for the map.
 */
export type CrossSourceLinkKind = 'origin' | 'relay';
export type CrossSourceLinkTransport = 'rf' | 'mqtt_gateway';

export interface CrossSourceLinkDto {
  /** Stable key for one edge (both ends, kind, transport). */
  key: string;
  protocol: 'meshtastic' | 'meshcore';
  /** `origin`: A's own packet, heard directly. `relay`: A likely relayed it (inferred). */
  kind: CrossSourceLinkKind;
  /** True for `relay` edges: inferred from a short relay hash, not proven. */
  inferred: boolean;
  /** `rf`: B's own radio. `mqtt_gateway`: a gateway/observer on source B heard it over RF. */
  transportClass: CrossSourceLinkTransport;
  txSourceId: string;
  txSourceName: string;
  txNodeId: string;
  txName: string | null;
  rxSourceId: string;
  rxSourceName: string;
  rxNodeId: string;
  rxName: string | null;
  /** Hearings in the window. */
  count: number;
  snrMin: number | null;
  snrAvg: number | null;
  snrMax: number | null;
  rssiAvg: number | null;
  lastHeardAt: number;
  /** `[lat, lon]` of the transmitting radio (arrow tail). */
  from: [number, number];
  /** `[lat, lon]` of the hearing radio (arrow head). */
  to: [number, number];
}

export interface CrossSourceLinksResponse {
  links: CrossSourceLinkDto[];
  sinceMs: number;
  retentionDays: number;
}

/**
 * API contract for `/api/analysis/cross-source-links/traceroute-confirmed`
 * (#5580): a link next to one of our own radios that a completed traceroute
 * used in BOTH directions, so each end demonstrably hears the other.
 */
export type TracerouteConfirmedTransport = 'rf' | 'udp' | 'mqtt';

export interface TracerouteConfirmedLinkDto {
  /** Stable key: source, neighbour and transport class. */
  key: string;
  sourceId: string;
  sourceName: string;
  /** Our own radio on `sourceId`. */
  localNodeNum: number;
  localNodeId: string;
  localName: string | null;
  /** The remote node on the other end of the link. */
  neighborNodeNum: number;
  neighborNodeId: string;
  neighborName: string | null;
  /** How the confirming traceroutes travelled this link. One row per class. */
  transportClass: TracerouteConfirmedTransport;
  /** Completed traceroutes that used this link both ways. */
  count: number;
  /** Of those, runs where the neighbour was the destination (zero hops). */
  directCount: number;
  /** Average dB at the neighbour, hearing us. Null = no run carried a sample. */
  snrOutAvg: number | null;
  /** Average dB at us, hearing the neighbour. Null = no run carried a sample. */
  snrBackAvg: number | null;
  lastConfirmedAt: number;
  /** `[lat, lon]` of our radio. */
  from: [number, number];
  /** `[lat, lon]` of the neighbour. */
  to: [number, number];
}

export interface TracerouteConfirmedLinksResponse {
  links: TracerouteConfirmedLinkDto[];
  sinceMs: number;
  /** True when the scan hit its row cap: older runs in the window were not read. */
  truncated: boolean;
  /** `TRACEROUTE_HISTORY_LIMIT`: runs kept per node pair, which caps `count`. */
  historyLimitPerPair: number;
}

