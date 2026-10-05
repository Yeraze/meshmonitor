/**
 * TAK module config (#5613): `ModuleConfig.TAKConfig { Team team = 1; MemberRole role = 2; }`,
 * firmware 2.8.0+.
 *
 * The values, names and labels below are copied from `enum Team` and
 * `enum MemberRole` in `protobufs/meshtastic/atak.proto` (the names keep the
 * proto's own spelling, "Unspecifed"). `takConfig.test.ts` checks every entry
 * against the pinned submodule, so a protobuf bump that adds a team or a role
 * fails there instead of going unseen.
 *
 * Shared by the server and the UI. Firmware reads these two fields only when
 * it builds a TAK position report, which it does only for device role
 * TAK_TRACKER (`PositionModule.cpp`).
 */

export interface TakEnumOption {
  /** Wire value. */
  value: number;
  /** Proto enum value name, as the Meshtastic CLI writes it in a config export. */
  name: string;
  /** `enum_value_metadata.label` from the proto. */
  label: string;
}

/** `enum Team` — the TAK team colour. 0 makes firmware use Cyan. */
export const TAK_TEAM_OPTIONS: readonly TakEnumOption[] = [
  { value: 0, name: 'Unspecifed_Color', label: 'Default (Cyan)' },
  { value: 1, name: 'White', label: 'White' },
  { value: 2, name: 'Yellow', label: 'Yellow' },
  { value: 3, name: 'Orange', label: 'Orange' },
  { value: 4, name: 'Magenta', label: 'Magenta' },
  { value: 5, name: 'Red', label: 'Red' },
  { value: 6, name: 'Maroon', label: 'Maroon' },
  { value: 7, name: 'Purple', label: 'Purple' },
  { value: 8, name: 'Dark_Blue', label: 'Dark Blue' },
  { value: 9, name: 'Blue', label: 'Blue' },
  { value: 10, name: 'Cyan', label: 'Cyan' },
  { value: 11, name: 'Teal', label: 'Teal' },
  { value: 12, name: 'Green', label: 'Green' },
  { value: 13, name: 'Dark_Green', label: 'Dark Green' },
  { value: 14, name: 'Brown', label: 'Brown' },
];

/** `enum MemberRole` — the TAK member role. 0 makes firmware use Team Member. */
export const TAK_ROLE_OPTIONS: readonly TakEnumOption[] = [
  { value: 0, name: 'Unspecifed', label: 'Default (Team Member)' },
  { value: 1, name: 'TeamMember', label: 'Team Member' },
  { value: 2, name: 'TeamLead', label: 'Team Lead' },
  { value: 3, name: 'HQ', label: 'HQ' },
  { value: 4, name: 'Sniper', label: 'Sniper' },
  { value: 5, name: 'Medic', label: 'Medic' },
  { value: 6, name: 'ForwardObserver', label: 'Forward Observer' },
  { value: 7, name: 'RTO', label: 'RTO' },
  { value: 8, name: 'K9', label: 'K9' },
];

export interface TakConfig {
  team: number;
  role: number;
}

/**
 * Read one TAK enum field as its number.
 *
 * A decoded config can hold the value three ways: a number, the proto name
 * (protobuf.js `toJSON` and the CLI's YAML export both write names), or nothing
 * at all (proto3 leaves a default off the wire). Unknown input reads as
 * undefined so a caller can tell "0" from "not a TAK value".
 */
function readTakEnum(options: readonly TakEnumOption[], raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') {
    return options.some((o) => o.value === raw) ? raw : undefined;
  }
  if (typeof raw === 'string') {
    const byName = options.find((o) => o.name === raw);
    if (byName) return byName.value;
    if (/^\d+$/.test(raw)) return readTakEnum(options, Number(raw));
  }
  return undefined;
}

/** The team as a number; unknown or absent input reads as 0 (default). */
export function takTeamToNumber(raw: unknown): number {
  return readTakEnum(TAK_TEAM_OPTIONS, raw) ?? 0;
}

/** The role as a number; unknown or absent input reads as 0 (default). */
export function takRoleToNumber(raw: unknown): number {
  return readTakEnum(TAK_ROLE_OPTIONS, raw) ?? 0;
}

/** The proto name for a team number, or undefined when the number is unknown. */
export function takTeamName(value: number): string | undefined {
  return TAK_TEAM_OPTIONS.find((o) => o.value === value)?.name;
}

/** The proto name for a role number, or undefined when the number is unknown. */
export function takRoleName(value: number): string | undefined {
  return TAK_ROLE_OPTIONS.find((o) => o.value === value)?.name;
}

/**
 * A decoded TAK config with both fields as numbers. Safe on undefined, on a
 * protobuf.js message (own fields only when on the wire) and on name strings.
 */
export function normalizeTakConfig(raw: unknown): TakConfig {
  const obj = raw && typeof raw === 'object' ? (raw as { team?: unknown; role?: unknown }) : {};
  return { team: takTeamToNumber(obj.team), role: takRoleToNumber(obj.role) };
}

/**
 * Check a TAK config a client wants to write. Returns an error message, or
 * null when it is fine.
 *
 * A value outside the enum would still encode, and the node would store a team
 * or role no TAK client knows. Refuse it here.
 */
export function validateTakConfigPayload(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'TAK config must be an object with team and role';
  }
  const { team, role } = config as { team?: unknown; role?: unknown };
  if (team !== undefined && readTakEnum(TAK_TEAM_OPTIONS, team) === undefined) {
    return `team must be one of the TAK team values (0-${TAK_TEAM_OPTIONS.length - 1})`;
  }
  if (role !== undefined && readTakEnum(TAK_ROLE_OPTIONS, role) === undefined) {
    return `role must be one of the TAK member roles (0-${TAK_ROLE_OPTIONS.length - 1})`;
  }
  return null;
}
