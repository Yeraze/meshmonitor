export interface RadioPreset {
  id: string;
  label: string;
  freq: number;
  bw: number;
  sf: number;
  cr: number;
  region?: string;
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
  { id: 'vn-narrow',     label: 'Vietnam (Narrow)',         freq: 920.250, bw: 62.5,  sf: 8,  cr: 5 },
  { id: 'vn-depr',       label: 'Vietnam (Deprecated)',     freq: 920.250, bw: 250,   sf: 11, cr: 5 },
];

export function findPresetId(freq: number, bw: number, sf: number, cr: number): string {
  const match = RADIO_PRESETS.find(
    p => p.freq === freq && p.bw === bw && p.sf === sf && p.cr === cr,
  );
  return match?.id ?? 'custom';
}
