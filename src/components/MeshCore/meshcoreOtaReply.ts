/**
 * Reading a MeshCore `start ota` reply (#4943 Phase 2). Shapes, from the
 * firmware (`src/helpers/ESP32Board.cpp`, `NRF52Board.cpp`, `CommonCLI.cpp`):
 *  - ESP32:  `Started: http://192.168.4.1/update`
 *  - nRF52:  `OK - mac: AA:BB:CC:DD:EE:FF`
 *  - others: `Error` (no OTA on this board or build)
 */
import type { CliRunResult } from './CliConsoleBody';

export type OtaReply =
  | { kind: 'esp32'; url: string }
  | { kind: 'nrf52'; mac: string }
  | { kind: 'unsupported' }
  | { kind: 'other'; text: string }
  | { kind: 'timeout' }
  | { kind: 'error'; text: string };

/** Read a `start ota` result. Unknown shapes fall back to the raw text. */
export function parseOtaReply(result: CliRunResult): OtaReply {
  if (!result.ok) {
    return result.code === 'CLI_TIMEOUT' ? { kind: 'timeout' } : { kind: 'error', text: result.error };
  }
  const text = (result.reply ?? '').trim();
  const url = /Started:\s*(https?:\/\/\S+)/i.exec(text);
  if (url) return { kind: 'esp32', url: url[1] };
  const mac = /OK\b.*?mac:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){5})/i.exec(text);
  if (mac) return { kind: 'nrf52', mac: mac[1].toUpperCase() };
  if (/^error\b/i.test(text)) return { kind: 'unsupported' };
  return { kind: 'other', text };
}

