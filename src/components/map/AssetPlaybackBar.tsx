import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import { UiIcon } from '../icons';
import type { TimeFormat, DateFormat } from '../../contexts/SettingsContext';
import { formatDateTime, formatTime } from '../../utils/datetime';
import { convertSpeed } from '../../utils/speedConversion';
import {
  positionAt,
  timelineGaps,
  nextFixTime,
  previousFixTime,
  nearestFixIndex,
  isOutsideCentralRegion,
  readStoredPlaybackSpeed,
  writeStoredPlaybackSpeed,
  PLAYBACK_SPEEDS,
  FOLLOW_PAN_INTERVAL_MS,
  PLAYBACK_COMMIT_INTERVAL_MS,
  type PlaybackFix,
  type PlaybackSpeed,
} from '../../utils/trackPlayback';
import styles from './AssetPlaybackBar.module.css';

export interface AssetPlaybackFix extends PlaybackFix {
  /** km/h, when the fix reported it. */
  groundSpeed?: number;
}

export interface AssetPlaybackBarProps {
  /** The asset's trail as the map shows it (after the hours filter), oldest first. */
  fixes: AssetPlaybackFix[];
  /** Leaflet map the playback marker is drawn on; null until the map mounts. */
  map: LeafletMap | null;
  /** Identity of the selected node. A change stops and resets playback. */
  resetKey: string;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  distanceUnit: 'km' | 'mi';
  /**
   * Called with the cursor time while "trail up to cursor" is on and the
   * cursor is short of the end, else with null (draw the whole trail).
   * Throttled to the ~5 Hz state rate, never per frame.
   */
  onTrailCursorChange: (cursorTime: number | null) => void;
}

/** SVG timeline width in viewBox units; the element stretches it to fit. */
const TIMELINE_UNITS = 1000;

/**
 * Timeline playback bar for a tracked asset (#5354 Phase 3).
 *
 * The marker moves imperatively (`setLatLng` inside a requestAnimationFrame
 * loop) so a frame never re-renders React; the cursor held in state, which
 * drives the readout and the trail-up-to-cursor callback, is only committed
 * about five times a second. That keeps the up to 2,000 trail polylines from
 * being rebuilt every frame.
 */
export function AssetPlaybackBar({
  fixes,
  map,
  resetKey,
  timeFormat,
  dateFormat,
  distanceUnit,
  onTrailCursorChange,
}: AssetPlaybackBarProps) {
  const { t } = useTranslation();
  const start = fixes.length > 0 ? fixes[0].timestamp : 0;
  const end = fixes.length > 0 ? fixes[fixes.length - 1].timestamp : 0;
  const span = end - start;

  // Committed cursor (~5 Hz while playing). cursorRef is the live value.
  const [cursor, setCursor] = useState(end);
  const cursorRef = useRef(end);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(() => readStoredPlaybackSpeed());
  const [trailToCursor, setTrailToCursor] = useState(true);
  const [follow, setFollow] = useState(false);

  const speedRef = useRef(speed);
  const followRef = useRef(follow);
  const lastPanRef = useRef(Number.NEGATIVE_INFINITY);
  const markerRef = useRef<LeafletMarker | null>(null);
  const cursorLineRef = useRef<SVGLineElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { followRef.current = follow; }, [follow]);

  const xFor = useCallback(
    (time: number) => (span > 0 ? ((time - start) / span) * TIMELINE_UNITS : TIMELINE_UNITS),
    [start, span],
  );

  /** Move the marker, the cursor line and (when following) the map. No React state. */
  const applyCursor = useCallback((time: number, now: number) => {
    const line = cursorLineRef.current;
    if (line) {
      const x = String(xFor(time));
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
    }
    const pos = positionAt(fixes, time);
    const marker = markerRef.current;
    if (!pos || !marker) return;
    marker.setLatLng([pos.lat, pos.lon]);
    marker.getElement()?.classList.toggle(styles.dimmed, pos.inGap);

    if (followRef.current && map && map.hasLayer(marker)) {
      const point = map.latLngToContainerPoint([pos.lat, pos.lon]);
      if (isOutsideCentralRegion(point, map.getSize()) && now - lastPanRef.current >= FOLLOW_PAN_INTERVAL_MS) {
        lastPanRef.current = now;
        map.panTo([pos.lat, pos.lon], { animate: true });
      }
    }
  }, [fixes, map, xFor]);

  /** Commit the cursor to React state and refresh the marker's time label. */
  const commitCursor = useCallback((time: number) => {
    setCursor(time);
    const label = markerRef.current?.getElement()?.querySelector(`.${styles.markerLabel}`);
    if (label) label.textContent = formatTime(new Date(time), timeFormat);
  }, [timeFormat]);

  /** Jump the cursor (click, drag, keys, step buttons). */
  const seek = useCallback((time: number) => {
    const clamped = Math.min(end, Math.max(start, time));
    cursorRef.current = clamped;
    applyCursor(clamped, performance.now());
    commitCursor(clamped);
  }, [start, end, applyCursor, commitCursor]);

  // Stop and reset when the node changes or the history reloads or is refiltered.
  useEffect(() => {
    setPlaying(false);
    cursorRef.current = end;
    setCursor(end);
    lastPanRef.current = Number.NEGATIVE_INFINITY;
  }, [fixes, resetKey, end]);

  // The playback marker: created once per map, shown only while playback is
  // away from "now" (at the end the node's own marker already sits there).
  useEffect(() => {
    if (!map) return;
    const icon = L.divIcon({
      className: styles.markerIcon,
      html: `<span class="${styles.markerDot}"></span><span class="${styles.markerLabel}"></span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    const marker = L.marker([0, 0], { icon, interactive: false, keyboard: false, zIndexOffset: 1000 });
    markerRef.current = marker;
    return () => {
      map.removeLayer(marker);
      markerRef.current = null;
    };
  }, [map]);

  const active = playing || cursor < end;
  useEffect(() => {
    const marker = markerRef.current;
    if (!map || !marker) return;
    if (active) {
      if (!map.hasLayer(marker)) {
        marker.addTo(map);
        const label = marker.getElement()?.querySelector(`.${styles.markerLabel}`);
        if (label) label.textContent = formatTime(new Date(cursorRef.current), timeFormat);
      }
      applyCursor(cursorRef.current, performance.now());
    } else {
      map.removeLayer(marker);
    }
  }, [active, map, applyCursor, timeFormat]);

  // Animation loop.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let lastCommit = 0;
    const frame = (now: number) => {
      if (last === null) {
        last = now;
        lastCommit = now;
      } else {
        const next = Math.min(end, cursorRef.current + (now - last) * speedRef.current);
        last = now;
        cursorRef.current = next;
        applyCursor(next, now);
        if (next >= end) {
          commitCursor(next);
          setPlaying(false);
          return;
        }
        if (now - lastCommit >= PLAYBACK_COMMIT_INTERVAL_MS) {
          lastCommit = now;
          commitCursor(next);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, end, applyCursor, commitCursor]);

  // Report the trail cutoff (committed rate only).
  const trailCursor = trailToCursor && cursor < end ? cursor : null;
  useEffect(() => {
    onTrailCursorChange(trailCursor);
  }, [trailCursor, onTrailCursorChange]);
  useEffect(() => () => onTrailCursorChange(null), [onTrailCursorChange]);

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      commitCursor(cursorRef.current);
      return;
    }
    if (cursorRef.current >= end) seek(start);
    setPlaying(true);
  }, [playing, start, end, seek, commitCursor]);

  const stepForward = useCallback(() => {
    setPlaying(false);
    seek(nextFixTime(fixes, cursorRef.current));
  }, [fixes, seek]);

  const stepBack = useCallback(() => {
    setPlaying(false);
    seek(previousFixTime(fixes, cursorRef.current));
  }, [fixes, seek]);

  const seekFromClientX = useCallback((clientX: number) => {
    const el = timelineRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seek(start + frac * span);
  }, [seek, start, span]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seekFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        stepBack();
        break;
      case 'ArrowRight':
        e.preventDefault();
        stepForward();
        break;
      case 'Home':
        e.preventDefault();
        setPlaying(false);
        seek(start);
        break;
      case 'End':
        e.preventDefault();
        setPlaying(false);
        seek(end);
        break;
      default:
        break;
    }
  };

  const onSpeedChange = (value: string) => {
    const next = Number(value) as PlaybackSpeed;
    if (!(PLAYBACK_SPEEDS as readonly number[]).includes(next)) return;
    setSpeed(next);
    writeStoredPlaybackSpeed(next);
  };

  const onFollowChange = (checked: boolean) => {
    setFollow(checked);
    followRef.current = checked;
    if (checked) {
      lastPanRef.current = Number.NEGATIVE_INFINITY;
      applyCursor(cursorRef.current, performance.now());
    }
  };

  // Notches: one path for every fix, not one element each (up to 2,000).
  const notchPath = useMemo(
    () => fixes.map(f => `M${xFor(f.timestamp).toFixed(1)} 5V19`).join(''),
    [fixes, xFor],
  );
  const gaps = useMemo(() => timelineGaps(fixes), [fixes]);

  const readout = useMemo(() => {
    const when = formatDateTime(new Date(cursor), timeFormat, dateFormat);
    const pos = positionAt(fixes, cursor);
    if (pos?.inGap) return `${when} · ${t('map.playback.noFixes', { defaultValue: 'no fixes (gap)' })}`;
    const nearest = fixes[nearestFixIndex(fixes, cursor)];
    if (nearest?.groundSpeed !== undefined && nearest.groundSpeed !== null) {
      const { speed: s, unit } = convertSpeed(nearest.groundSpeed, distanceUnit);
      return `${when} · ${s} ${unit}`;
    }
    return when;
  }, [cursor, fixes, timeFormat, dateFormat, distanceUnit, t]);

  const cursorX = xFor(cursor);

  return (
    <div className={styles.bar} data-testid="asset-playback-bar">
      <div className={styles.buttons}>
        <button
          type="button"
          className={`${styles.button} ${styles.stepButton}`}
          onClick={stepBack}
          aria-label={t('map.playback.stepBack', { defaultValue: 'Previous fix' })}
          title={t('map.playback.stepBack', { defaultValue: 'Previous fix' })}
        >
          <UiIcon name="stepBack" size={16} />
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.playButton}`}
          onClick={togglePlay}
          aria-label={playing ? t('map.playback.pause', { defaultValue: 'Pause' }) : t('map.playback.play', { defaultValue: 'Play' })}
          title={playing ? t('map.playback.pause', { defaultValue: 'Pause' }) : t('map.playback.play', { defaultValue: 'Play' })}
          data-testid="asset-playback-play"
        >
          <UiIcon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.stepButton}`}
          onClick={stepForward}
          aria-label={t('map.playback.stepForward', { defaultValue: 'Next fix' })}
          title={t('map.playback.stepForward', { defaultValue: 'Next fix' })}
        >
          <UiIcon name="stepForward" size={16} />
        </button>
      </div>

      <div className={styles.timelineColumn}>
        <div className={styles.readout} aria-hidden="true" data-testid="asset-playback-readout">{readout}</div>
        <div
          ref={timelineRef}
          className={styles.timeline}
          role="slider"
          tabIndex={0}
          aria-label={t('map.playback.timeline', { defaultValue: 'Playback timeline' })}
          aria-valuemin={start}
          aria-valuemax={end}
          aria-valuenow={Math.round(cursor)}
          aria-valuetext={readout}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="asset-playback-timeline"
        >
          <svg
            className={styles.svg}
            viewBox={`0 0 ${TIMELINE_UNITS} 24`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {gaps.map(g => (
              <rect
                key={`${g.start}-${g.end}`}
                className={styles.gap}
                x={xFor(g.start)}
                y={0}
                width={Math.max(0, xFor(g.end) - xFor(g.start))}
                height={24}
              />
            ))}
            <rect className={styles.played} x={0} y={10} width={cursorX} height={4} />
            <path className={styles.notches} d={notchPath} vectorEffect="non-scaling-stroke" />
            <line
              ref={cursorLineRef}
              className={styles.cursor}
              x1={cursorX}
              x2={cursorX}
              y1={0}
              y2={24}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>

      <div className={styles.options}>
        <select
          className={styles.speed}
          value={speed}
          onChange={e => onSpeedChange(e.target.value)}
          aria-label={t('map.playback.speed', { defaultValue: 'Playback speed' })}
          data-testid="asset-playback-speed"
        >
          {PLAYBACK_SPEEDS.map(s => (
            <option key={s} value={s}>
              {t('map.playback.speedOption', { speed: s, defaultValue: '{{speed}}×' })}
            </option>
          ))}
        </select>
        <label
          className={styles.toggle}
          title={t('map.playback.trailToCursor', { defaultValue: 'Trail up to cursor' })}
        >
          <input
            type="checkbox"
            checked={trailToCursor}
            onChange={e => setTrailToCursor(e.target.checked)}
            data-testid="asset-playback-trail"
          />
          <UiIcon name="route" size={14} />
          <span className={styles.toggleText}>
            {t('map.playback.trailToCursor', { defaultValue: 'Trail up to cursor' })}
          </span>
        </label>
        <label
          className={styles.toggle}
          title={t('map.playback.follow', { defaultValue: 'Follow' })}
        >
          <input
            type="checkbox"
            checked={follow}
            onChange={e => onFollowChange(e.target.checked)}
            data-testid="asset-playback-follow"
          />
          <UiIcon name="target" size={14} />
          <span className={styles.toggleText}>
            {t('map.playback.follow', { defaultValue: 'Follow' })}
          </span>
        </label>
      </div>
    </div>
  );
}

export default AssetPlaybackBar;
