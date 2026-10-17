/**
 * MeshCore Companion text CLI (#5866), shared by the server dispatcher and the
 * Local Console.
 *
 * Companion firmware 1.18.0 (companion protocol v14) added CMD_RUN_CLI_COMMAND
 * (66), answered by RESP_CODE_CLI_REPLY (29). Its verbs are config reads and
 * writes (`get/set radio`, `tx`, `af`, `name`, `tz.offset`, `wifi.*`, ...)
 * plus `ver`, `board`, `reboot` and `poweroff`. It has no `stats`, `clock` or
 * `advert`, so those keep running through the bridge-command shim.
 */

/** DeviceInfo `fw ver` (companion protocol) byte that first carries the CLI. */
export const COMPANION_NATIVE_CLI_MIN_PROTOCOL = 14;

/** Firmware `cmd_frame` is MAX_FRAME_SIZE (172); one byte goes to the opcode. */
export const COMPANION_NATIVE_CLI_MAX_BYTES = 170;

/** Verbs the shim answers even when the firmware has its own CLI. */
export const COMPANION_SYNTHETIC_CLI_VERBS: ReadonlySet<string> = new Set([
  'stats', 'clock', 'time', 'advert', 'advert.zerohop', 'help', '?', 'version',
]);

export function companionHasNativeCli(firmwareVer: number | null | undefined): boolean {
  return (firmwareVer ?? 0) >= COMPANION_NATIVE_CLI_MIN_PROTOCOL;
}
