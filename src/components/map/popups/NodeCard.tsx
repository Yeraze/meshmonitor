/**
 * `NodeCard` — the popup-family chrome (spec §2.1). Renders the canonical
 * `.node-popup` header + optional tab bar + `.node-popup-content` body,
 * byte-identical to the structure `MapNodePopupContent`/`DashboardNodePopup`
 * already use (the canonical `.node-popup-grid` card wins per D3).
 *
 * `NodeCard` owns nothing but chrome + tab state — it doesn't know about
 * permissions, node data shape, or which sections a consumer needs. A
 * consumer composes its `sections` (and optional `tracerouteBody`) from the
 * section registry in `sections.tsx`.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeCardHeader } from './sections';
import type { NodeCardModel } from './nodeCardModel';
import { UiIcon } from '../../icons';

export type NodeCardTab = 'info' | 'traceroute';

export interface NodeCardProps {
  model: NodeCardModel;
  /** Ordered content sections composed below the header (and inside the
   *  active INFO tab, when tabs are present). */
  sections: React.ReactNode;
  /** Optional tabbed layout. When present, `sections` is the INFO tab body
   *  and `tracerouteBody` is the TRACEROUTE tab body; a tab bar renders.
   *  Omit entirely (rather than passing `undefined` explicitly is fine too)
   *  for a tab-less card — `sections` then renders directly. */
  tracerouteBody?: React.ReactNode;
  /** Extra class on the root, e.g. `node-popup-overlay` for the NodePopup
   *  chat-overlay fixed frame (WP5). */
  className?: string;
}

export const NodeCard: React.FC<NodeCardProps> = ({ model, sections, tracerouteBody, className }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<NodeCardTab>('info');

  const hasTabs = tracerouteBody !== undefined;

  return (
    <div className={className ? `node-popup ${className}` : 'node-popup'}>
      <NodeCardHeader model={model} />

      {hasTabs && (
        <div className="node-popup-tabs">
          <button
            className={`node-popup-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
            title={t('node_popup.tab_info', 'Node Info')}
          >
            <UiIcon name="info" />
          </button>
          <button
            className={`node-popup-tab ${activeTab === 'traceroute' ? 'active' : ''}`}
            onClick={() => setActiveTab('traceroute')}
            title={t('node_popup.tab_traceroute', 'Traceroute')}
          >
            <UiIcon name="radioSignal" />
          </button>
        </div>
      )}

      <div className="node-popup-content">
        {hasTabs ? (activeTab === 'info' ? sections : tracerouteBody) : sections}
      </div>
    </div>
  );
};

export default NodeCard;
