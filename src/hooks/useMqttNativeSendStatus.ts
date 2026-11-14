/**
 * MQTT-native send status for one MQTT source (#4305): whether the source may
 * send with no radio, and the node id it sends as. App reads it to show the
 * existing message composer on an MQTT source and to route its sends.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';

export interface MqttNativeStatus {
  sourceId: string;
  enabled: boolean;
  readiness: { ok: true } | { ok: false; code: 'READ_ONLY' | 'NOT_CONNECTED'; reason: string };
  identity: {
    nodeNum: number;
    nodeId: string;
    publicKey: string;
    longName: string;
    shortName: string;
    lastNodeInfoAt: number | null;
  } | null;
  identityBlocker: string | null;
  config: {
    hopLimit: number;
    maxPerMinute: number;
    maxPerHour: number;
    longName: string;
    shortName: string;
    rootTopic: string | null;
    announceChannelId: number | null;
  };
  rootTopicHint: string | null;
  effectiveRootTopic: string | null;
  limits: {
    hardMaxPerMinute: number;
    hardMaxPerHour: number;
    maxHopLimit: number;
    nodeInfoIntervalMs: number;
    longNameMaxBytes: number;
    shortNameMaxBytes: number;
  };
}

export function mqttNativeStatusQueryKey(sourceId: string | null | undefined) {
  return ['mqttNativeSend', sourceId ?? null] as const;
}

/** Status for an MQTT source, or null for any other source / no access. */
export function useMqttNativeSendStatus(sourceId: string | null | undefined, isMqttSource: boolean): MqttNativeStatus | null {
  const { data } = useQuery({
    queryKey: mqttNativeStatusQueryKey(sourceId),
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data: MqttNativeStatus }>(
        `/api/sources/${encodeURIComponent(sourceId as string)}/mqtt/native`,
      );
      return res?.data ?? null;
    },
    enabled: !!sourceId && isMqttSource,
    staleTime: 60_000,
    retry: false,
  });
  return isMqttSource ? data ?? null : null;
}
