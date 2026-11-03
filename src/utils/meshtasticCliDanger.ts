/**
 * Danger-command pattern for the Meshtastic remote-admin CLI console (#6154).
 *
 * Shared between the server route (src/server/services/meshtasticCli.ts) and the
 * client console (src/components/admin-commands/MeshtasticRemoteCliConsole.tsx,
 * passed to the shared CliConsoleBody as its `dangerPattern`) so the typed-name
 * confirmation modal and the server's `confirm:true` enforcement always agree on
 * what is destructive.
 *
 * The leading MeshCore verbs (reboot / erase / clkreboot / factory / poweroff /
 * shutdown) are kept for parity with the shared console; the trailing group adds
 * the Meshtastic-specific destructive flags that have no bare-verb equivalent:
 *   --reset-nodedb   wipes the node database
 *   --remove-node    removes a node from the NodeDB
 *   --enter-dfu      drops the device into DFU (unreachable until reflashed)
 *   --factory-reset / --factory-reset-device  (matched by `factory`)
 *
 * The trailing `(?!\.)` keeps a danger word used as a dotted-key prefix
 * (e.g. `get reboot.interval`) from matching.
 *
 * IMPORTANT: the server tests this against the QUOTE-AWARE PARSED argv, not the
 * raw input, so evasive quoting such as `--rebo"o"t` (which parses to
 * `--reboot`) cannot slip past the guard.
 */
export const MESHTASTIC_DANGER_COMMAND_PATTERN =
  /\b(reboot|erase|clkreboot|factory|poweroff|shutdown|reset-nodedb|remove-node|enter-dfu)\b(?!\.)/i;

/** True when the (already-parsed-and-joined) argument text names a destructive command. */
export function isMeshtasticDangerCommand(args: string): boolean {
  return MESHTASTIC_DANGER_COMMAND_PATTERN.test(args);
}
