export interface RadioPreset {
  id: string;
  label: string;
  freq: number;
  bw: number;
  sf: number;
  cr: number;
  region?: string;
  /**
   * Anything a node needs BEYOND freq/bw/sf/cr to actually join this mesh.
   *
   * A preset only carries the four radio parameters, so a community that also
   * standardises on a setting living elsewhere in the app would otherwise get
   * a node that looks configured and still cannot talk. Shown as a hint under
   * the preset picker (#5137).
   */
  note?: string;
}

export const RADIO_PRESETS: ReadonlyArray<RadioPreset> = [
  { id: 'au',             label: 'Australia',               freq: 915.800, bw: 250,   sf: 10, cr: 5 },
  { id: 'au-narrow',     label: 'Australia (Narrow)',       freq: 916.575, bw: 62.5,  sf: 7,  cr: 8 },
  { id: 'au-mid',        label: 'Australia (Mid)',          freq: 915.075, bw: 125,   sf: 9,  cr: 5 },
  { id: 'au-sa-wa',      label: 'Australia: SA, WA',        freq: 923.125, bw: 62.5,  sf: 8,  cr: 8 },
  { id: 'au-qld',        label: 'Australia: QLD',           freq: 923.125, bw: 62.5,  sf: 8,  cr: 5 },
  { id: 'eu-uk-narrow',  label: 'EU/UK (Narrow)',           freq: 869.618, bw: 62.5,  sf: 8,  cr: 8 },
  { id: 'eu-uk-depr',    label: 'EU/UK (Deprecated)',       freq: 869.525, bw: 250,   sf: 11, cr: 5 },
  { id: 'cz-narrow',     label: 'Czech Republic (Narrow)',  freq: 869.432, bw: 62.5,  sf: 7,  cr: 5 },
  { id: 'eu433-lr',      label: 'EU 433MHz (Long Range)',   freq: 433.650, bw: 250,   sf: 11, cr: 5 },
  { id: 'eu433-narrow',  label: 'EU 433MHz (Narrow)',       freq: 433.650, bw: 62.5,  sf: 8,  cr: 8 },
  { id: 'nz',            label: 'New Zealand',              freq: 917.375, bw: 250,   sf: 11, cr: 5 },
  { id: 'nz-narrow',     label: 'New Zealand (Narrow)',     freq: 917.375, bw: 62.5,  sf: 7,  cr: 5 },
  { id: 'pt433',         label: 'Portugal 433',             freq: 433.375, bw: 62.5,  sf: 9,  cr: 6 },
  { id: 'pt868',         label: 'Portugal 868',             freq: 869.618, bw: 62.5,  sf: 7,  cr: 6 },
  { id: 'ch',            label: 'Switzerland',              freq: 869.618, bw: 62.5,  sf: 8,  cr: 8 },
  { id: 'us-ca',         label: 'USA/Canada (Recommended)', freq: 910.525, bw: 62.5,  sf: 7,  cr: 5 },
  // Philly Mesh moved the region to "MeshCore 500" on 2026-09-02 to get inside
  // FCC 15.247(a)(2), which wants >= 500 kHz in the 900 MHz ISM band. 902.250
  // is chosen to sit clear of the ISM interference they measured every 250 kHz.
  // https://phillymesh.net/2026/09/02/fcc-regulations/
  { id: 'us-philly',     label: 'USA: Philadelphia (MeshCore 500)',
    freq: 902.250, bw: 500, sf: 11, cr: 5,
    note: 'Philly Mesh also standardises on a 2-byte path hash. Set "Default path hash size" to 2 bytes in Settings — this preset only carries the radio parameters.' },
  { id: 'vn-narrow',     label: 'Vietnam (Narrow)',         freq: 920.250, bw: 62.5,  sf: 8,  cr: 5 },
  { id: 'vn-depr',       label: 'Vietnam (Deprecated)',     freq: 920.250, bw: 250,   sf: 11, cr: 5 },
];

export function findPresetId(freq: number, bw: number, sf: number, cr: number): string {
  const match = RADIO_PRESETS.find(
    p => p.freq === freq && p.bw === bw && p.sf === sf && p.cr === cr,
  );
  return match?.id ?? 'custom';
}
