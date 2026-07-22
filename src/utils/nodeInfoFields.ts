// One label per NodeInfo field. Keys match NODE_INFO_FIELDS in nodeInfoCopyService.
// Plain strings (matching the existing modal, which does not i18n these) — keep parity;
// i18n of field labels is out of scope for this phase.
export const NODE_INFO_DISPLAY_FIELDS = [
  { key: 'longName',        label: 'Long Name' },
  { key: 'shortName',       label: 'Short Name' },
  { key: 'hwModel',         label: 'Hardware Model' },
  { key: 'role',            label: 'Role' },
  { key: 'macaddr',         label: 'MAC Address' },
  { key: 'publicKey',       label: 'Public Key' },
  { key: 'hasPKC',          label: 'Has PKC' },
  { key: 'firmwareVersion', label: 'Firmware' },
] as const;

export type NodeInfoFieldKey = typeof NODE_INFO_DISPLAY_FIELDS[number]['key'];

export const NODE_INFO_FIELD_LABELS: Record<NodeInfoFieldKey, string> =
  Object.fromEntries(NODE_INFO_DISPLAY_FIELDS.map(f => [f.key, f.label])) as Record<NodeInfoFieldKey, string>;

/** Map a fillableFields key to its human label, falling back to the raw key. */
export function nodeInfoFieldLabel(key: string): string {
  return (NODE_INFO_FIELD_LABELS as Record<string, string>)[key] ?? key;
}
