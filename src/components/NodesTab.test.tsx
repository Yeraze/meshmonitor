/**
 * @vitest-environment jsdom
 *
 * NodesTab Component Tests
 *
 * Tests helper functions and basic functionality. jsdom is required even
 * for the pure `computeNeighborLinkStyle` import below because importing
 * NodesTab.tsx pulls in `leaflet`, which touches `window` at module load.
 */

import { describe, it, expect } from 'vitest';
import { computeNeighborLinkStyle, isTracerouteRunDisabled } from './NodesTab';
import {
  getEffectivePosition,
  resolveMarkerCenterTarget,
} from '../utils/nodeHelpers';
import {
  shouldOffsetForPrecision,
  offsetWithinPrecisionCell,
} from '../utils/precisionOffset';
import type { DeviceInfo } from '../types/device';

describe('NodesTab', () => {
  // #4047 Phase 7 WP11 — pins NodesTab's neighbor-link adapter: the 4-tier
  // SNR→weight/opacity table (deliberately NOT the shared layer's continuous
  // snrToNeighborOpacity curve, see utils/neighborLinks.ts) and the
  // unidirectional-only arrow gate consumed by the shared NeighborLinksLayer.
  describe('computeNeighborLinkStyle', () => {
    const color = '#f5a623';

    it('applies the strong tier (weight 4, opacity 0.85) for snr > 10', () => {
      const { pathOptions } = computeNeighborLinkStyle(15, true, color);
      expect(pathOptions.weight).toBe(4);
      expect(pathOptions.opacity).toBe(0.85);
      expect(pathOptions.color).toBe(color);
    });

    it('applies the mid tier (weight 3, opacity 0.6) for 0 <= snr <= 10', () => {
      expect(computeNeighborLinkStyle(10, true, color).pathOptions).toMatchObject({ weight: 3, opacity: 0.6 });
      expect(computeNeighborLinkStyle(0, true, color).pathOptions).toMatchObject({ weight: 3, opacity: 0.6 });
    });

    it('applies the weak tier (weight 2, opacity 0.4) for snr < 0', () => {
      expect(computeNeighborLinkStyle(-5, true, color).pathOptions).toMatchObject({ weight: 2, opacity: 0.4 });
    });

    it('applies the unknown tier (weight 2, opacity 0.3) for null snr', () => {
      expect(computeNeighborLinkStyle(null, true, color).pathOptions).toMatchObject({ weight: 2, opacity: 0.3 });
    });

    it('omits dashArray and arrows for bidirectional links', () => {
      const { pathOptions, arrows } = computeNeighborLinkStyle(5, true, color);
      expect(pathOptions.dashArray).toBeUndefined();
      expect(arrows).toBeUndefined();
    });

    it('dashes the line and emits an arrow descriptor for unidirectional links', () => {
      const { pathOptions, arrows } = computeNeighborLinkStyle(5, false, color);
      expect(pathOptions.dashArray).toBe('5, 5');
      expect(arrows).toEqual({ color });
    });
  });


  // Epic #4294 Phase 2 — the map node popup's "Run Traceroute" button
  // (rendered via TracerouteBody inside a Leaflet Popup/Marker/MapContainer
  // tree that isn't practical to fully render in jsdom) must be disabled
  // whenever the source's TX is disabled, in addition to the pre-existing
  // not-connected/already-running gates. NodesTab wires this boolean via
  // isTracerouteRunDisabled(...) and sets the button's title from
  // tx_disabled.control_tooltip whenever txDisabled is true — see the
  // <TracerouteBody runDisabled=.../runDisabledReason=.../> call site.
  describe('isTracerouteRunDisabled (map popup traceroute run-button gating)', () => {
    it('is disabled when txDisabled is true, even while connected and idle', () => {
      expect(isTracerouteRunDisabled('connected', null, '!aaaaaaaa', true)).toBe(true);
    });

    it('is enabled when connected, idle, and txDisabled is false', () => {
      expect(isTracerouteRunDisabled('connected', null, '!aaaaaaaa', false)).toBe(false);
    });

    it('stays disabled for the pre-existing not-connected gate regardless of txDisabled', () => {
      expect(isTracerouteRunDisabled('disconnected', null, '!aaaaaaaa', false)).toBe(true);
    });

    it('stays disabled for the pre-existing already-running gate regardless of txDisabled', () => {
      expect(isTracerouteRunDisabled('connected', '!aaaaaaaa', '!aaaaaaaa', false)).toBe(true);
    });
  });

  // Regression for the "clicking a node pans to a random location, not the
  // node" bug: markers for low-precision/obscured nodes are rendered at an
  // in-cell OFFSET position (#4016), but the click handler used to pan to the
  // raw reported cell-center — up to half an accuracy cell (km-scale) away.
  // resolveMarkerCenterTarget must hand back the same offset position the
  // marker uses so the map pans exactly to the marker the user clicked.
  describe('resolveMarkerCenterTarget (click pans to the marker, not the raw center)', () => {
    const NODE_NUM = 0x1234abcd;
    const RAW_LAT = 40.0;
    const RAW_LNG = -74.0;
    const OBSCURED_BITS = 13; // town-level: a multi-km accuracy cell

    // Build the offset marker position exactly as NodesTab's nodePositions memo does.
    const buildMarkerPos = (): [number, number] => {
      const node = {
        nodeNum: NODE_NUM,
        user: { id: '!1234abcd' },
        position: { latitude: RAW_LAT, longitude: RAW_LNG },
        positionPrecisionBits: OBSCURED_BITS,
      } as unknown as DeviceInfo;
      const eff = getEffectivePosition(node);
      expect(shouldOffsetForPrecision(OBSCURED_BITS, node.positionIsOverride)).toBe(true);
      return offsetWithinPrecisionCell(
        eff.latitude as number,
        eff.longitude as number,
        OBSCURED_BITS,
        String(node.user?.id ?? node.nodeNum),
      );
    };

    it('returns the offset marker position, which differs materially from the raw center', () => {
      const markerPos = buildMarkerPos();
      const nodePositions = new Map<number, [number, number]>([[NODE_NUM, markerPos]]);

      const target = resolveMarkerCenterTarget(NODE_NUM, nodePositions);
      expect(target).toEqual(markerPos);

      // The whole point of the fix: this is NOT the raw reported center.
      expect(target).not.toEqual([RAW_LAT, RAW_LNG]);
      const dLat = Math.abs((target as [number, number])[0] - RAW_LAT);
      const dLng = Math.abs((target as [number, number])[1] - RAW_LNG);
      expect(dLat + dLng).toBeGreaterThan(0.001); // ~>100m of divergence at 13 bits
    });

    it('returns null when the node has no rendered marker (caller falls back to raw center)', () => {
      const nodePositions = new Map<number, [number, number]>();
      expect(resolveMarkerCenterTarget(NODE_NUM, nodePositions)).toBeNull();
    });
  });

  describe('Helper Functions', () => {
    describe('isToday', () => {
      it('should return true for today\'s date', () => {
        const today = new Date();
        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(today)).toBe(true);
      });

      it('should return false for yesterday', () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(yesterday)).toBe(false);
      });

      it('should return false for tomorrow', () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(tomorrow)).toBe(false);
      });

      it('should handle dates from different months', () => {
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(lastMonth)).toBe(false);
      });

      it('should handle dates from different years', () => {
        const lastYear = new Date();
        lastYear.setFullYear(lastYear.getFullYear() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(lastYear)).toBe(false);
      });
    });
  });

  describe('Date Handling', () => {
    it('should correctly identify same day dates', () => {
      const date1 = new Date(2025, 0, 15, 10, 30);
      const date2 = new Date(2025, 0, 15, 15, 45);

      const areSameDay = (d1: Date, d2: Date): boolean => {
        return d1.getDate() === d2.getDate() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getFullYear() === d2.getFullYear();
      };

      expect(areSameDay(date1, date2)).toBe(true);
    });

    it('should correctly identify different day dates', () => {
      const date1 = new Date(2025, 0, 15, 23, 59);
      const date2 = new Date(2025, 0, 16, 0, 1);

      const areSameDay = (d1: Date, d2: Date): boolean => {
        return d1.getDate() === d2.getDate() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getFullYear() === d2.getFullYear();
      };

      expect(areSameDay(date1, date2)).toBe(false);
    });
  });
});
