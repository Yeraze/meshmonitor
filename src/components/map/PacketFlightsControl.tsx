/**
 * Map Features control for live packet traffic (#4835): the toggle, a one-line
 * hint, the per-viewer rate slider and the "N dropped" count.
 *
 * Rendered by the NodesTab and DashboardMap Map Features panels and by the
 * MeshCore map's own panel. Off by default.
 */
import { useTranslation } from 'react-i18next';
import { PACKET_FLIGHT_RATE_STEPS } from '../../utils/packetFlightEdges';
import styles from './PacketFlightsControl.module.css';

export interface PacketFlightsControlProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Most dots per second; 0 = all. */
  rate: number;
  onRateChange: (rate: number) => void;
  /** Flights dropped by the rate limit since the layer turned on. */
  dropped: number;
  /** When set, the toggle is disabled with this title (e.g. in 3D view). */
  disabledTitle?: string;
}

const stepIndexOf = (rate: number): number => {
  const i = PACKET_FLIGHT_RATE_STEPS.indexOf(rate as (typeof PACKET_FLIGHT_RATE_STEPS)[number]);
  return i >= 0 ? i : PACKET_FLIGHT_RATE_STEPS.length - 1;
};

export function PacketFlightsControl({ checked, onCheckedChange, rate, onRateChange, dropped, disabledTitle }: PacketFlightsControlProps) {
  const { t } = useTranslation();
  const active = checked && !disabledTitle;
  const stepIndex = stepIndexOf(rate);
  const rateLabel = rate > 0
    ? t('map.packet_flights.rate_value', '{{count}} per second', { count: rate })
    : t('map.packet_flights.rate_all', 'All');

  return (
    <div className={styles.root} data-testid="packet-flights-control">
      <label
        className="map-control-item"
        title={disabledTitle ?? t('map.packet_flights.toggle_hint', 'Shows packets as they arrive, as dots flying to the node that heard them.')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!!disabledTitle}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        <span>{t('map.packet_flights.toggle', 'Live packet traffic')}</span>
      </label>
      {active && (
        <div className={styles.panel}>
          <div className={styles.hint}>
            {t('map.packet_flights.hint', 'Shows packets as they arrive. Dashed = sent somewhere upstream; the last hop is not known.')}
          </div>
          <label className={styles.rateLabel} htmlFor="packet-flights-rate">
            <span>{t('map.packet_flights.rate', 'Max dots')}</span>
            <span data-testid="packet-flights-rate-value">{rateLabel}</span>
          </label>
          <input
            id="packet-flights-rate"
            className={styles.slider}
            type="range"
            min={0}
            max={PACKET_FLIGHT_RATE_STEPS.length - 1}
            step={1}
            value={stepIndex}
            onChange={(e) => onRateChange(PACKET_FLIGHT_RATE_STEPS[Number(e.target.value)] ?? 0)}
            aria-label={t('map.packet_flights.rate_label', 'Most packet dots per second')}
            aria-valuetext={rateLabel}
          />
          {dropped > 0 && (
            <div className={styles.dropped} role="status" data-testid="packet-flights-dropped">
              {t('map.packet_flights.dropped', '{{count}} dropped', { count: dropped })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PacketFlightsControl;
