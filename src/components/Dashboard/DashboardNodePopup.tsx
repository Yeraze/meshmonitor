/**
 * DashboardNodePopup — richly formatted marker popup for the Dashboard map.
 *
 * Thin composition over the popup family (`src/components/map/popups/`,
 * #4047 Phase 5 WP2): normalizes the flat-or-nested node shape via
 * `toNodeCardModel` and composes the canonical `NodeCard` chrome from the
 * shared section registry. The composed section order (Header → Identity →
 * Signal → Position → LastHeard → Sources) is the family's canonical order;
 * see docs/internal/dev-notes/MAP_CONSOLIDATION_P5_SPEC.md §WP2 for the
 * orchestrator-approved item-order change (Hardware/Hops and SNR/Battery
 * swap places vs. the pre-Phase-5 layout — everything else, including the
 * ID item's full-width formatting, stays byte-identical).
 *
 * Consumers: DashboardMap.tsx, MapAnalysis/layers/NodeMarkersLayer.tsx.
 */

import { useDisplaySettings } from '../../contexts/SettingsContext';
import { NodeCard } from '../map/popups/NodeCard';
import { IdentityItems, SignalItems, PositionItem, LastHeardFooter, SourcesList } from '../map/popups/sections';
import { toNodeCardModel, type NodeSourceRef } from '../map/popups/nodeCardModel';

export type { NodeSourceRef };

interface DashboardNodePopupProps {
  node: unknown;
  pos: { lat: number; lng: number };
  /**
   * Called when the user clicks one of the "seen by" source rows. The Unified
   * map uses this to jump to that source's Node Details view for this node.
   */
  onSourceSelect?: (source: NodeSourceRef, nodeId: string | undefined) => void;
}

export default function DashboardNodePopup({ node, pos, onSourceSelect }: DashboardNodePopupProps) {
  const { timeFormat, dateFormat, distanceUnit } = useDisplaySettings();

  const model = toNodeCardModel(node, 'meshtastic', { pos });

  return (
    <NodeCard
      model={model}
      sections={
        <>
          <div className="node-popup-grid">
            <IdentityItems model={model} idFullWidth />
            <SignalItems model={model} showAltitude distanceUnit={distanceUnit} />
            <PositionItem position={pos} />
          </div>
          <LastHeardFooter
            lastHeard={model.lastHeard}
            mode="relative"
            timeFormat={timeFormat}
            dateFormat={dateFormat}
          />
          <SourcesList sources={model.sources} nodeId={model.nodeId} onSourceSelect={onSourceSelect} />
        </>
      }
    />
  );
}
