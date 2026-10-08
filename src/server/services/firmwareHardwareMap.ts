/**
 * Firmware Hardware Map (server entry point)
 *
 * The map itself lives in `src/utils/firmwareHardwareMap.ts` so the browser
 * can read the same list the server enforces (#5677): the Firmware Updates
 * pane and OTA preflight must agree on which hardware can be updated. Server
 * code keeps importing from here.
 */
export * from '../../utils/firmwareHardwareMap.js';
