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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  // Issue #4342 — "GeoJSON overlay tooltip blocks waypoint creation".
  //
  // Leaflet's bindPopup handler calls DomEvent.stop() on the layer's click
  // (leaflet/src/layer/Popup.js `_openPopup`), which sets
  // originalEvent._stopped, and Map._fireDOMEvent bails out of its target loop
  // as soon as that flag is set — BEFORE it reaches the map itself. So any
  // click landing on popup-bound overlay geometry (a GeoJSON feature, a node
  // or waypoint marker, a traceroute line, a neighbor link, an accuracy
  // region) opened that layer's popup and never reached the map 'click'
  // handler in WaypointMapEventBridge, so no waypoint was created.
  //
  // The fix makes interactive geometry click-through for the duration of
  // placement, which is a hit-testing property jsdom cannot exercise — so this
  // pins the CSS contract instead: as long as `.waypoint-placing` is on the
  // container (WaypointMapEventBridge's first effect), interactive overlay
  // geometry must not be a pointer target. Deleting that rule silently
  // reintroduces the bug.
  describe('waypoint placement mode suppresses overlay hit-testing (#4342)', () => {
    const css = readFileSync(resolve('src/components/WaypointEditorModal.css'), 'utf8');

    // Strip comments so the prose above the rule can't satisfy the assertions.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

    it('makes .leaflet-interactive click-through while .waypoint-placing is set', () => {
      const rule = rules.match(
        /\.leaflet-container\.waypoint-placing\s+\.leaflet-interactive\s*\{[^}]*\}/g,
      )?.find(r => /pointer-events\s*:\s*none/.test(r));

      expect(rule, 'pointer-events:none rule for .waypoint-placing .leaflet-interactive is missing').toBeDefined();
      // Leaflet's own `.leaflet-pane > svg path.leaflet-interactive` /
      // `.leaflet-marker-icon.leaflet-interactive { pointer-events: auto }`
      // rules are more specific, so the override has to be !important.
      expect(rule).toMatch(/pointer-events\s*:\s*none\s*!important/);
    });

    it('keeps the crosshair cursor rule that signals placement mode', () => {
      expect(rules).toMatch(/\.leaflet-container\.waypoint-placing[^{]*\{[^}]*cursor\s*:\s*crosshair/);
    });
  });

  // #4379 — NodesTab renders under leaflet + a stack of contexts, so the node
  // row can't be mounted here. These assertions read the source instead, which
  // is enough to pin the two structural promises the issue extracted: the
  // interactive controls are separated from the inert status icons, and the
  // route to Node Details exists on EVERY row rather than only unmessageable
  // ones.
  describe('node row separates status indicators from actions (#4379)', () => {
    const src = readFileSync(resolve('src/components/NodesTab.tsx'), 'utf8');

    const strip = src.slice(
      src.indexOf('<div className="node-actions">'),
      src.indexOf('<div className="node-short">'),
    );
    const actionsAt = strip.indexOf('nodeRowStyles.actions');
    const indicatorGroup = strip.slice(strip.indexOf('nodeRowStyles.indicators'), actionsAt);
    const actionGroup = strip.slice(actionsAt);

    it('puts the unmessageable badge among the inert indicators, with no props', () => {
      // Self-closing with no props is the assertion that matters: an
      // `onOpenDetails` prop reappearing means the badge became a control
      // again, which is exactly what #4379 asked to undo.
      expect(indicatorGroup).toContain('<NodeUnmessageableBadge />');
      expect(actionGroup).not.toContain('NodeUnmessageableBadge');
    });

    it('puts the details button in the action group, away from the icon strip', () => {
      expect(actionGroup).toContain('<NodeDetailsButton');
      expect(indicatorGroup).not.toContain('NodeDetailsButton');
    });

    it('offers Node Details on every node, not just unmessageable ones', () => {
      const detailsAt = actionGroup.indexOf('<NodeDetailsButton');
      const guard = actionGroup.slice(actionGroup.lastIndexOf('{', detailsAt), detailsAt);

      // #4333's affordance only existed on unmessageable rows. The issue asks
      // for it "consistently in the node list", so messageability must not
      // appear in this guard at all.
      expect(guard).not.toMatch(/isUnmessagable/);
      // It stays permission-gated because Node Details still lives inside the
      // Messages tab — an ungated button would strand users on a tab they
      // cannot see.
      expect(guard).toMatch(/hasPermission\('messages', 'read'\)/);
    });

    it('still withholds the Send-DM button from unmessageable nodes', () => {
      const dmAt = actionGroup.indexOf("t('nodes.send_dm')");
      expect(dmAt).toBeGreaterThan(-1);
      const guard = actionGroup.slice(0, dmAt);

      expect(guard).toMatch(/!node\.isUnmessagable/);
    });

    it('routes row double-click to details as a second path, like MeshCore', () => {
      // Single-click is already taken (select + center the map), so the row's
      // double-click is the free slot — MeshCoreNodesView does the same.
      expect(src).toMatch(/onDoubleClick=\{hasPermission\('messages', 'read'\) \? handleNodeDetailsClick\(node\)/);
    });

    it('draws a divider between the two groups, but only when both are present', () => {
      const css = readFileSync(resolve('src/components/NodeRowActions.module.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');

      // `:not(:empty)` is load-bearing: a node with zero status indicators
      // would otherwise render a stray leading rule.
      expect(css).toMatch(/\.indicators:not\(:empty\)\s*\+\s*\.actions\s*\{[^}]*border-left/);
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
