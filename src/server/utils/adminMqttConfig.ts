/**
 * The `/api/admin/load-config` reply for the MQTT module, shared by the local
 * and remote branches of that route.
 *
 * The admin Save sends the whole MQTTConfig back to the node, and firmware
 * replaces the struct with what it gets. So every field the node reports must
 * reach the form, or the next Save turns it off. Before this the reply carried
 * only the broker fields (TLS joined in #5700), and each save wiped client
 * proxy, map reporting and the map report settings.
 *
 * `raw` is a decoded protobuf.js MQTTConfig (or `{}` when the node sent an
 * all-default config). proto3 leaves `false` and `0` off the wire, and an unset
 * scalar on a decoded instance reads as null, so a bool is true only when the
 * node said `true` and a number falls back to 0 (the firmware's "use default").
 */
export interface AdminMqttConfig {
  enabled: boolean;
  address: string;
  username: string;
  password: string;
  encryptionEnabled: boolean;
  jsonEnabled: boolean;
  tlsEnabled: boolean;
  root: string;
  proxyToClientEnabled: boolean;
  mapReportingEnabled: boolean;
  mapReportSettings: {
    publishIntervalSecs: number;
    positionPrecision: number;
    shouldReportLocation: boolean;
  };
}

function toUint(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

type Raw = Record<string, unknown>;

export function formatAdminMqttConfig(raw: Raw | null | undefined): AdminMqttConfig {
  const mqtt: Raw = raw ?? {};
  const map: Raw = (mqtt.mapReportSettings as Raw | null | undefined) ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    enabled: mqtt.enabled === true,
    address: str(mqtt.address),
    username: str(mqtt.username),
    password: str(mqtt.password),
    // `!== false` used to read an elided false as true, so a save turned
    // encryption back on for a node that had it off.
    encryptionEnabled: mqtt.encryptionEnabled === true,
    jsonEnabled: mqtt.jsonEnabled === true,
    tlsEnabled: mqtt.tlsEnabled === true,
    root: str(mqtt.root),
    proxyToClientEnabled: mqtt.proxyToClientEnabled === true,
    mapReportingEnabled: mqtt.mapReportingEnabled === true,
    mapReportSettings: {
      publishIntervalSecs: toUint(map.publishIntervalSecs),
      positionPrecision: toUint(map.positionPrecision),
      shouldReportLocation: map.shouldReportLocation === true,
    },
  };
}
