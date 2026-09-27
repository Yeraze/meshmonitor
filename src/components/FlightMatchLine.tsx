/**
 * ADS-B flight match line for a likely-aircraft node (#5374), e.g.
 * "Matched: UAL123 · B738 · N12345 · 450 kt 270°", linked to the flight on
 * the feed's map and credited ("Data: adsb.lol"). Renders nothing unless the
 * node is flagged, matching is on, and the server has a match.
 *
 * Fetches lazily: the query only runs while this component is mounted (an
 * open popup or details panel). Also renders nothing outside a TanStack
 * QueryClientProvider, so a surface without one degrades to no line.
 */
import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryClientContext } from '@tanstack/react-query';
import { UiIcon } from './icons';
import { useFlightMatch } from '../hooks/useFlightMatch';
import { formatFlightMatchDetails } from '../utils/flightMatchFormat';
import styles from './FlightMatchLine.module.css';

export interface FlightMatchLineProps {
  sourceId: string | null | undefined;
  nodeNum: number | null | undefined;
  likelyAircraft: boolean;
  /** `popup` renders a `.node-popup-item`; `details` a `.node-detail-card`. */
  variant: 'popup' | 'details';
}

const FlightMatchLineInner: React.FC<FlightMatchLineProps> = ({ sourceId, nodeNum, likelyAircraft, variant }) => {
  const { t } = useTranslation();
  const { data: match } = useFlightMatch({ sourceId, nodeNum, likelyAircraft });
  if (!match) return null;

  const prefix = match.status === 'matched'
    ? t('flight_match.matched', 'Matched')
    : t('flight_match.possible', 'Possible match');
  const details = formatFlightMatchDetails(match);
  const text = `${prefix}: ${details}`;
  const title = t('flight_match.link_title', 'Open this flight on {{feed}}', { feed: match.feedName });

  const body = (
    <span className={styles.line} data-testid="flight-match-line">
      {match.flightUrl ? (
        <a className={styles.link} href={match.flightUrl} target="_blank" rel="noopener noreferrer" title={title}>
          {text}
        </a>
      ) : (
        text
      )}
      <span className={styles.credit}>
        {t('flight_match.credit', 'Data: {{feed}}', { feed: match.feedName })}
      </span>
    </span>
  );

  if (variant === 'popup') {
    return (
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="aircraft" /></span>
        <span className="node-popup-value">{body}</span>
      </div>
    );
  }
  return (
    <div className="node-detail-card">
      <div className={`node-detail-label ${styles.detailsLabel}`}>
        <UiIcon name="aircraft" size={14} /> {t('flight_match.label', 'Flight (ADS-B)')}
      </div>
      <div className="node-detail-value">{body}</div>
    </div>
  );
};

const FlightMatchLine: React.FC<FlightMatchLineProps> = (props) => {
  const client = useContext(QueryClientContext);
  if (!client || !props.likelyAircraft) return null;
  return <FlightMatchLineInner {...props} />;
};

export default FlightMatchLine;
