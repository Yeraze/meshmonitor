/** Which danger-zone actions a device offers (#6255 P9 S5). */
export interface DeviceManagementCapabilities {
  reboot: boolean;
  powerOff: boolean;
  keyExport: boolean;
  keyImport: boolean;
  factoryReset: boolean;
  /** Why an action is unavailable, shown as the button's tooltip. */
  reasons?: Partial<Record<'reboot' | 'powerOff' | 'keyExport' | 'keyImport' | 'factoryReset', string>>;
}

/** The Companion's capabilities: everything but power-off, which needs protocol 14+. */
export function companionCapabilities(firmwareVer?: number): DeviceManagementCapabilities {
  return {
    reboot: true,
    powerOff: typeof firmwareVer === 'number' && firmwareVer >= 14,
    keyExport: true,
    keyImport: true,
    factoryReset: true,
  };
}
