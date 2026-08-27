/**
 * MeshCore receive-only mode (#4547) — bridge-command classification.
 *
 * `sendBridgeCommand` carries BOTH over-the-air commands and local serial
 * config commands, so the receive-only gate must be command-name aware.
 *
 * FAIL-CLOSED: `isRfBridgeCommand()` returns true for any name not explicitly
 * listed as serial-only. A bridge command added in the future without touching
 * this file is therefore BLOCKED in receive-only mode rather than silently
 * transmitting. `meshcoreTx.test.ts` additionally fails the build so the
 * omission is caught at review time, not at runtime.
 */

/** Commands that put energy on the LoRa radio. Blocked in receive-only mode. */
export const RF_BRIDGE_COMMANDS: ReadonlySet<string> = new Set([
  'send_message',
  'send_advert',
  'send_cli',
  'discover_path',
  'discover_nodes',
  'request_owner',
  'request_regions',
  'request_telemetry',
  'trace_path',
  'share_contact',
  'get_neighbours',
  'login',
  'get_status',
  'reset_path',
]);

/** Local-serial-only commands. Allowed in receive-only mode. */
export const SERIAL_ONLY_BRIDGE_COMMANDS: ReadonlySet<string> = new Set([
  'get_channels', 'set_channel', 'delete_channel',
  'get_self_info', 'get_contacts', 'remove_contact',
  'set_contact_favorite', 'set_contacts_favorite',
  'export_contact', 'import_contact',
  'export_private_key', 'import_private_key',
  'set_name', 'set_radio', 'set_tx_power', 'set_coords',
  'set_advert_loc_policy', 'set_other_params', 'set_flood_scope', 'set_out_path',
  'set_path_hash_mode', // #4945: writes NodePrefs.path_hash_mode, no RF TX
  'set_telemetry_mode_base', 'set_telemetry_mode_loc', 'set_telemetry_mode_env',
  'get_stats', 'get_device_time', 'set_device_time', 'device_query',
  'reboot', 'shutdown', 'ping',
]);

export function isRfBridgeCommand(cmd: string): boolean {
  return !SERIAL_ONLY_BRIDGE_COMMANDS.has(cmd);
}

/** Local-CLI verbs (Companion synthetic CLI and Repeater serial CLI) that transmit. */
export const RF_LOCAL_CLI_VERBS: ReadonlySet<string> = new Set(['advert']);

export function isTransmittingLocalCliVerb(command: string): boolean {
  const verb = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return RF_LOCAL_CLI_VERBS.has(verb);
}

/** Single user-facing message for every receive-only rejection. */
export const MESHCORE_RECEIVE_ONLY_MESSAGE =
  'Transmission blocked: this MeshCore source is configured for receive-only operation.';
