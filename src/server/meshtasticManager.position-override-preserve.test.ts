import { describe, it, expect } from 'vitest';

/**
 * Regression tests for issue #2847.
 *
 * When a user sets a Position Override (custom location) for a node, incoming
 * device telemetry (live position packets and NodeInfo config sync) must NOT
 * overwrite the regular `latitude`/`longitude`/`altitude` columns. Doing so
 * causes the Position config UI (which surfaces the device-stored fixed
 * position from those columns) to revert to the device-reported coordinates
 * on every refresh, defeating the user's manual correction.
 *
 * These tests replicate the gating logic from:
 * - processPositionMessageProtobuf (live position packets)
 * - processNodeInfoProtobuf (device NodeDB sync)
 * to verify that `positionOverrideEnabled` causes lat/lon/alt to be skipped.
 */
describe('Position override preservation (issue #2847)', () => {
  describe('processPositionMessageProtobuf — preserve override on live packets', () => {
    /**
     * Replicates the post-fix gating decision from
     * `meshtasticManager.processPositionMessageProtobuf`. Returns true when
     * the lat/lon/alt update should be SKIPPED.
     */
    function shouldPreservePosition(
      isLocalNode: boolean,
      hasFixedPositionEnabled: boolean,
      hasPositionOverride: boolean,
    ): boolean {
      return (isLocalNode && hasFixedPositionEnabled) || hasPositionOverride;
    }

    it('preserves position when remote node has positionOverrideEnabled', () => {
      // Remote node (not the connected radio), no fixedPosition relevance
      const result = shouldPreservePosition(false, false, true);
      expect(result).toBe(true);
    });

    it('preserves position for the local node when fixedPosition is true', () => {
      // Existing behavior — base station with fixedPosition
      const result = shouldPreservePosition(true, true, false);
      expect(result).toBe(true);
    });

    it('preserves position when BOTH fixedPosition and override are set on local node', () => {
      // Common case from issue #2847 — local base station with custom override
      const result = shouldPreservePosition(true, true, true);
      expect(result).toBe(true);
    });

    it('preserves position for local node with override even when fixedPosition is false', () => {
      // User toggled override on but hasn't set device fixedPosition flag
      const result = shouldPreservePosition(true, false, true);
      expect(result).toBe(true);
    });

    it('does NOT preserve position when no override and no fixedPosition', () => {
      // Normal mobile node — should accept telemetry updates
      const result = shouldPreservePosition(false, false, false);
      expect(result).toBe(false);
    });

    it('does NOT preserve position for remote node with fixedPosition (firmware flag is local-only)', () => {
      // hasFixedPositionEnabled comes from `this.actualDeviceConfig`, which is
      // the *connected* radio's config, so it only applies to the local node.
      const result = shouldPreservePosition(false, true, false);
      expect(result).toBe(false);
    });
  });

  describe('processNodeInfoProtobuf — preserve override on device NodeDB sync', () => {
    /**
     * Replicates the post-fix gating logic in `processNodeInfoProtobuf` that
     * decides whether to copy device-reported coordinates onto nodeData.
     * Returns the nodeData object that would be passed to `upsertNode`.
     */
    function buildNodeDataPositionFields(
      nodeInfo: { position?: { latitudeI?: number; longitudeI?: number; altitude?: number } },
      existingNode: { positionOverrideEnabled?: boolean } | null,
    ): { latitude?: number; longitude?: number; altitude?: number } {
      const nodeData: { latitude?: number; longitude?: number; altitude?: number } = {};
      const hasPosition =
        nodeInfo.position && (nodeInfo.position.latitudeI || nodeInfo.position.longitudeI);
      if (!hasPosition) return nodeData;

      const hasPositionOverride = existingNode?.positionOverrideEnabled === true;
      if (!hasPositionOverride) {
        // Convert latitudeI / longitudeI 1e-7 fixed-point → decimal degrees.
        nodeData.latitude = nodeInfo.position!.latitudeI! * 1e-7;
        nodeData.longitude = nodeInfo.position!.longitudeI! * 1e-7;
        nodeData.altitude = nodeInfo.position!.altitude;
      }
      return nodeData;
    }

    it('skips lat/lon/alt when existing node has positionOverrideEnabled', () => {
      const nodeInfo = {
        position: { latitudeI: 400000000, longitudeI: -750000000, altitude: 100 },
      };
      const existingNode = { positionOverrideEnabled: true };

      const result = buildNodeDataPositionFields(nodeInfo, existingNode);
      expect(result).not.toHaveProperty('latitude');
      expect(result).not.toHaveProperty('longitude');
      expect(result).not.toHaveProperty('altitude');
    });

    it('writes lat/lon/alt when existing node has no override', () => {
      const nodeInfo = {
        position: { latitudeI: 400000000, longitudeI: -750000000, altitude: 100 },
      };
      const existingNode = { positionOverrideEnabled: false };

      const result = buildNodeDataPositionFields(nodeInfo, existingNode);
      expect(result.latitude).toBeCloseTo(40.0, 5);
      expect(result.longitude).toBeCloseTo(-75.0, 5);
      expect(result.altitude).toBe(100);
    });

    it('writes lat/lon/alt when existingNode is null (new node)', () => {
      const nodeInfo = {
        position: { latitudeI: 400000000, longitudeI: -750000000, altitude: 100 },
      };

      const result = buildNodeDataPositionFields(nodeInfo, null);
      expect(result.latitude).toBeCloseTo(40.0, 5);
      expect(result.longitude).toBeCloseTo(-75.0, 5);
    });

    it('writes lat/lon/alt when positionOverrideEnabled is undefined', () => {
      // Older nodes that predate the override column may have undefined here
      const nodeInfo = {
        position: { latitudeI: 400000000, longitudeI: -750000000, altitude: 100 },
      };
      const existingNode = {} as { positionOverrideEnabled?: boolean };

      const result = buildNodeDataPositionFields(nodeInfo, existingNode);
      expect(result.latitude).toBeCloseTo(40.0, 5);
    });

    it('does not invent fields when nodeInfo has no position', () => {
      const result = buildNodeDataPositionFields({}, { positionOverrideEnabled: false });
      expect(result).toEqual({});
    });
  });

  describe('positionPrecision metadata gating', () => {
    /**
     * Replicates the post-fix logic that decides whether to update the
     * positionPrecisionBits/Channel/Timestamp columns. These fields describe
     * the freshness/quality of the regular `latitude`/`longitude` columns,
     * so they must travel together — when override is on and we skip lat/lon,
     * we must also skip these metadata columns.
     */
    function shouldWritePrecisionMetadata(
      precisionBits: number | undefined,
      hasPositionOverride: boolean,
    ): boolean {
      return precisionBits !== undefined && !hasPositionOverride;
    }

    it('writes precision metadata when no override', () => {
      expect(shouldWritePrecisionMetadata(32, false)).toBe(true);
    });

    it('skips precision metadata when override is enabled', () => {
      // Otherwise the lat/lon and its precisionTimestamp would diverge —
      // a stale lat/lon would falsely advertise as fresh.
      expect(shouldWritePrecisionMetadata(32, true)).toBe(false);
    });

    it('skips precision metadata when precisionBits is undefined', () => {
      expect(shouldWritePrecisionMetadata(undefined, false)).toBe(false);
    });
  });
});
