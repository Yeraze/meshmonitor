export interface DeviceInfo {
  nodeNum: number
  user?: {
    id: string
    longName: string
    shortName: string
    hwModel?: number
    role?: string
  }
  position?: {
    latitude: number
    longitude: number
    altitude?: number
  }
  deviceMetrics?: {
    batteryLevel?: number
    voltage?: number
    channelUtilization?: number
    airUtilTx?: number
  }
  hopsAway?: number
  lastHeard?: number
  snr?: number
  rssi?: number
  firmwareVersion?: string
}

export interface Channel {
  id: number
  name: string
  psk?: string
  uplinkEnabled: boolean
  downlinkEnabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Database node type with additional fields
 */
export interface DbNode extends Partial<DeviceInfo> {
  nodeId?: string
  longName?: string
  shortName?: string
  macaddr?: string
  latitude?: number
  longitude?: number
  altitude?: number
  batteryLevel?: number
  voltage?: number
  channelUtilization?: number
  airUtilTx?: number
  createdAt?: number
  updatedAt?: number
  lastTracerouteRequest?: number
}