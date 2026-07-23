/**
 * ATAK `Team` / `MemberRole` enum lookups (ATAK/CoT Phase 2, issue #3691).
 * Values verified against `protobufs/meshtastic/atak.proto` — see
 * `docs/internal/dev-notes/ATAK_COT_PHASE2_SPEC.md` §1/§2i.
 */

/** Team enum int → CSS color. Unspecified (0) and unknown ints fall back to Cyan. */
export const TEAM_COLORS: Record<number, string> = {
  0: '#00ffff', // Unspecifed_Color -> default Cyan
  1: '#ffffff', // White
  2: '#ffff00', // Yellow
  3: '#ff7e00', // Orange
  4: '#ff00ff', // Magenta
  5: '#ff0000', // Red
  6: '#7e0000', // Maroon
  7: '#7e00ff', // Purple
  8: '#00007e', // Dark_Blue
  9: '#0000ff', // Blue
  10: '#00ffff', // Cyan (default)
  11: '#007e7e', // Teal
  12: '#00ff00', // Green
  13: '#007e00', // Dark_Green
  14: '#7e3e00', // Brown
};

export const DEFAULT_TEAM_COLOR = '#00ffff';

/** Team enum int → display label. */
export const TEAM_LABELS: Record<number, string> = {
  0: 'Unspecified',
  1: 'White',
  2: 'Yellow',
  3: 'Orange',
  4: 'Magenta',
  5: 'Red',
  6: 'Maroon',
  7: 'Purple',
  8: 'Dark Blue',
  9: 'Blue',
  10: 'Cyan',
  11: 'Teal',
  12: 'Green',
  13: 'Dark Green',
  14: 'Brown',
};

/** MemberRole enum int → display label. */
export const ROLE_LABELS: Record<number, string> = {
  0: 'Unspecified',
  1: 'Team Member',
  2: 'Team Lead',
  3: 'HQ',
  4: 'Sniper',
  5: 'Medic',
  6: 'Forward Observer',
  7: 'RTO',
  8: 'K9',
};

/** Resolves a team's marker/swatch color, falling back to Cyan for null/unknown ints. */
export function teamColor(team: number | null | undefined): string {
  if (team === null || team === undefined) return DEFAULT_TEAM_COLOR;
  return TEAM_COLORS[team] ?? DEFAULT_TEAM_COLOR;
}

/** Resolves a team's display label, falling back to "Unspecified" for null/unknown ints. */
export function teamLabel(team: number | null | undefined): string {
  if (team === null || team === undefined) return TEAM_LABELS[0];
  return TEAM_LABELS[team] ?? TEAM_LABELS[0];
}

/** Resolves a role's display label, falling back to "Unspecified" for null/unknown ints. */
export function roleLabel(role: number | null | undefined): string {
  if (role === null || role === undefined) return ROLE_LABELS[0];
  return ROLE_LABELS[role] ?? ROLE_LABELS[0];
}
