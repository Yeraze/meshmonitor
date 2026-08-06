import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings, TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import { DraggableOverlay } from './DraggableOverlay';
import { MESHCORE_CATEGORIES, NODE_TYPE_CATEGORY_META } from '../utils/nodeTypeCategory';
import { roleGlyphMarkerSvg } from '../utils/mapIcons';
import { useIsMobileViewport } from '../hooks/useIsMobileViewport';
import './MapLegend.css';
import { UiIcon } from './icons';

// Color for the node-type glyph swatches. Matches the MeshCore map's marker
// accent (the only surface that currently opts into the node-type legend).
const NODE_TYPE_LEGEND_COLOR = '#cba6f7';

interface LinkLegendItem {
  color: string;
  width: number;
  dashArray?: string;
  opacity: number;
  label: string;
}

export interface PositionHistoryData {
  oldestTime: number;
  newestTime: number;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

interface MapLegendProps {
  positionHistory?: PositionHistoryData;
  /** Count of known nodes with neither a real nor an estimated position (issue #3271). */
  unmappedCount?: number;
  /** Render the MeshCore node-type glyph legend (issue #3546). Opt-in so the
   *  Meshtastic maps that share this component are unaffected. */
  showNodeTypes?: boolean;
}

// Default position: top-right, below the Features checkbox panel, right-aligned with it
// Map container starts at top: 60px (header)
// Features panel is at right: 10px (relative to map), height ~250px when expanded
const getDefaultPosition = () => ({
  x: window.innerWidth - 200 - 10, // right-align with FEATURES panel (right: 10px)
  y: 60 + 10 + 250 + 20 // header + features top + features height + gap = 340
});

const MapLegend: React.FC<MapLegendProps> = ({ positionHistory, unmappedCount, showNodeTypes }) => {
  const { t } = useTranslation();
  const { overlayColors } = useSettings();
  const isMobile = useIsMobileViewport();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const stored = localStorage.getItem('mapLegendCollapsed');
    if (stored !== null) return stored === 'true';
    // Desktop: expanded by default — the panel is draggable and sits clear of
    // the map. Mobile (#4389): the card overlays the map it describes, so it
    // starts as a compact pill the reader taps open.
    return isMobile;
  });

  const handleToggleCollapse = () => {
    const newValue = !isCollapsed;
    setIsCollapsed(newValue);
    localStorage.setItem('mapLegendCollapsed', String(newValue));
  };

  // On mobile the whole header is the tap target — a 24px chevron is a poor
  // touch target, and the legend has no other action to compete with the tap.
  // The chevron keeps working; it just stops the click reaching the header so
  // one tap is not counted twice.
  const handleCollapseButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleToggleCollapse();
  };

  const handleHeaderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleCollapse();
    }
  };

  // The mobile card renders inside the Leaflet container, so a touch that
  // starts on it would otherwise pan the map underneath — and a scroll of the
  // legend body would drag the map with it. DraggableOverlay does the same for
  // the desktop panel; this branch does not go through it, so it repeats the
  // guard rather than inheriting it. stopPropagation only hides the event from
  // Leaflet; it does not preventDefault, so the card still scrolls normally.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const types = ['wheel', 'dblclick', 'mousedown', 'touchstart', 'pointerdown'];
    types.forEach((type) => el.addEventListener(type, stop, { capture: true }));
    return () => types.forEach((type) => el.removeEventListener(type, stop, { capture: true }));
  }, [isMobile]);

  const mobileHeaderProps: React.HTMLAttributes<HTMLDivElement> = isMobile
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !isCollapsed,
        onClick: handleToggleCollapse,
        onKeyDown: handleHeaderKeyDown,
      }
    : {};

  // Hop gradient: local green → blue → purple → red
  const hopGradientCss = `linear-gradient(to right, ${overlayColors.hopColors.local}, ${overlayColors.hopColors.gradient.join(', ')})`;

  // Other overlay line types (non-neighbor)
  const otherLineItems: LinkLegendItem[] = [
    { color: overlayColors.tracerouteForward, width: 2, dashArray: '3,6', opacity: 1, label: t('map.legend.traceroute', 'Traceroute') },
    { color: overlayColors.mqttSegment, width: 2, dashArray: '3,6', opacity: 1, label: t('map.legend.mqtt', 'IP') },
  ];

  const formatTime = (timestamp: number) => {
    if (!positionHistory) return '';
    return formatDateTime(new Date(timestamp), positionHistory.timeFormat, positionHistory.dateFormat);
  };

  const legendBody = (
    <>
      <div className="legend-gradient-container">
        <div
          className="legend-gradient-bar"
          style={{ background: hopGradientCss }}
        />
        <div className="legend-gradient-labels">
          <span className="legend-gradient-label">{t('map.legend.local')}</span>
          <span className="legend-gradient-label">6+</span>
        </div>
      </div>
      <div className="legend-divider" />
      <span className="legend-title">{t('map.legend.neighbors', 'Neighbors')}</span>
      {/* Line style: solid = bidirectional, dashed = one-way */}
      <div className="legend-item">
        <svg width="24" height="12" className="legend-line-sample">
          <line x1="0" y1="6" x2="24" y2="6"
            stroke={overlayColors.neighborLine} strokeWidth={4} strokeOpacity={0.85} />
        </svg>
        <span className="legend-label">{t('map.legend.bidirectional', 'Bidirectional')}</span>
      </div>
      <div className="legend-item">
        <svg width="24" height="12" className="legend-line-sample">
          <line x1="0" y1="6" x2="18" y2="6"
            stroke={overlayColors.neighborLine} strokeWidth={2} strokeDasharray="5,5" strokeOpacity={0.5} />
          <polygon points="18,2 24,6 18,10" fill={overlayColors.neighborLine} opacity={0.7} />
        </svg>
        <span className="legend-label">{t('map.legend.unidirectional', 'One-way')}</span>
      </div>
      <span className="legend-sublabel" style={{ fontSize: '0.7rem', color: 'var(--color-text-subtle)', marginTop: '2px' }}>
        {t('map.legend.thickerBrighter', 'Thicker line = stronger signal')}
      </span>
      <div className="legend-divider" />
      <span className="legend-title">{t('map.legend.otherLines', 'Other Lines')}</span>
      {otherLineItems.map((item) => (
        <div key={item.label} className="legend-item">
          <svg width="24" height="12" className="legend-line-sample">
            <line x1="0" y1="6" x2="24" y2="6"
              stroke={item.color} strokeWidth={item.width}
              strokeDasharray={item.dashArray || 'none'} strokeOpacity={item.opacity} />
          </svg>
          <span className="legend-label">{item.label}</span>
        </div>
      ))}
      {showNodeTypes && (
        <>
          <div className="legend-divider" />
          <span className="legend-title">{t('map.nodeType.legendTitle', 'Node Types')}</span>
          {/* Standard nodes keep the default marker, so only the four
              glyph categories are listed (matches the analysis legend). */}
          {MESHCORE_CATEGORIES.filter((c) => c !== 'standard').map((category) => {
            const meta = NODE_TYPE_CATEGORY_META[category];
            return (
              <div key={category} className="legend-item">
                <span
                  className="legend-line-sample"
                  style={{ display: 'inline-flex', width: 20, height: 20 }}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: roleGlyphMarkerSvg(category, NODE_TYPE_LEGEND_COLOR, 20) }}
                />
                <span className="legend-label">{t(meta.labelKey, meta.label)}</span>
              </div>
            );
          })}
        </>
      )}
      {positionHistory && (
        <>
          <div className="legend-divider" />
          <span className="legend-title">{t('map.legend.positionHistory')}</span>
          <div className="legend-gradient-container">
            <div
              className="legend-gradient-bar"
              style={{
                background: `linear-gradient(to right, rgb(${overlayColors.positionHistoryOld.r}, ${overlayColors.positionHistoryOld.g}, ${overlayColors.positionHistoryOld.b}), rgb(${overlayColors.positionHistoryNew.r}, ${overlayColors.positionHistoryNew.g}, ${overlayColors.positionHistoryNew.b}))`,
              }}
            />
            <div className="legend-gradient-labels">
              <span className="legend-gradient-label oldest">{t('map.legend.oldest')}</span>
              <span className="legend-gradient-label newest">{t('map.legend.newest')}</span>
            </div>
          </div>
          <div className="legend-time-labels">
            <span className="legend-time-label">{formatTime(positionHistory.oldestTime)}</span>
            <span className="legend-time-label">{formatTime(positionHistory.newestTime)}</span>
          </div>
        </>
      )}
      {unmappedCount != null && unmappedCount > 0 && (
        <>
          <div className="legend-divider" />
          <span className="legend-sublabel" style={{ fontSize: '0.75rem', color: 'var(--color-text-subtle)' }}>
            {t('map.legend.unmappedNodes', '{{count}} node(s) without location', { count: unmappedCount })}
          </span>
        </>
      )}
    </>
  );

  const panel = (
    <div className={`map-legend ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="legend-header" {...mobileHeaderProps}>
        <span className="legend-title">{t('map.legend.hops')}</span>
        <button
          className="legend-collapse-btn"
          onClick={handleCollapseButtonClick}
          onMouseDown={(e) => e.stopPropagation()}
          title={isCollapsed ? 'Expand legend' : 'Collapse legend'}
        >
          <UiIcon name={isCollapsed ? 'chevronDown' : 'chevronUp'} size={15} />
        </button>
      </div>
      {/* The scroll container exists on mobile only, where the card is capped
          at 50vh — wrapping the body unconditionally would turn the legend's
          direct flex children into grandchildren and change desktop spacing. */}
      {!isCollapsed && (isMobile ? <div className="legend-body">{legendBody}</div> : legendBody)}
    </div>
  );

  // Mobile: a docked, tap-to-expand card instead of the draggable overlay
  // (#4389). `.map-legend-wrapper` used to be `display: none` here while the
  // Features-panel "Show Legend" checkbox stayed toggleable, so the control
  // drove something that could never appear. Dragging a floating panel around a
  // phone screen is not useful, so this branch skips DraggableOverlay entirely
  // — which leaves `.draggable-overlay`'s own mobile `display: none` untouched
  // for its other consumers (TilesetSelector's desktop path,
  // PositionHistoryLegend).
  //
  // Deliberately NOT the #4380 bottom sheet: the tile selector is a "pick one,
  // then dismiss" control, so a full-width sheet that closes on selection fits.
  // The legend is purely informational with nothing to select, so it stays a
  // small corner card the reader opens and closes at will, and it sits clear of
  // (and under) the tile-selector sheet so the two can be open at once.
  if (isMobile) {
    return (
      <div ref={cardRef} className="map-legend-wrapper map-legend-mobile">
        {panel}
      </div>
    );
  }

  return (
    <DraggableOverlay
      id="map-legend"
      defaultPosition={getDefaultPosition()}
      className="map-legend-wrapper"
    >
      {panel}
    </DraggableOverlay>
  );
};

export default MapLegend;
