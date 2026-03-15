import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type DateFormat,
	type TimeFormat,
	useSettings,
} from "../contexts/SettingsContext";
import { formatDateTime } from "../utils/datetime";
import { getHopColor } from "../utils/mapIcons";
import { DraggableOverlay } from "./DraggableOverlay";
import "./MapLegend.css";

interface LegendItem {
	hops: string;
	color: string;
	label: string;
	translate?: boolean;
}

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
}

// Default position: top-right, below the Features checkbox panel, right-aligned with it
// Map container starts at top: 60px (header)
// Features panel is at right: 10px (relative to map), height ~250px when expanded
const getDefaultPosition = () => ({
	x: window.innerWidth - 200 - 10, // right-align with FEATURES panel (right: 10px)
	y: 60 + 10 + 250 + 20, // header + features top + features height + gap = 340
});

const MapLegend: React.FC<MapLegendProps> = ({ positionHistory }) => {
	const { t } = useTranslation();
	const { overlayColors } = useSettings();
	const [isCollapsed, setIsCollapsed] = useState(() => {
		const stored = localStorage.getItem("mapLegendCollapsed");
		return stored !== null ? stored === "true" : false; // expanded by default
	});

	const handleToggleCollapse = () => {
		const newValue = !isCollapsed;
		setIsCollapsed(newValue);
		localStorage.setItem("mapLegendCollapsed", String(newValue));
	};

	const legendItems: LegendItem[] = [
		{
			hops: "0",
			color: getHopColor(0, overlayColors.hopColors),
			label: "map.legend.local",
			translate: true,
		},
		{ hops: "1", color: getHopColor(1, overlayColors.hopColors), label: "1" },
		{ hops: "2", color: getHopColor(2, overlayColors.hopColors), label: "2" },
		{ hops: "3", color: getHopColor(3, overlayColors.hopColors), label: "3" },
		{ hops: "4", color: getHopColor(4, overlayColors.hopColors), label: "4" },
		{ hops: "5", color: getHopColor(5, overlayColors.hopColors), label: "5" },
		{ hops: "6+", color: getHopColor(6, overlayColors.hopColors), label: "6+" },
	];

	// Other overlay line types (non-neighbor)
	const otherLineItems: LinkLegendItem[] = [
		{
			color: overlayColors.tracerouteForward,
			width: 2,
			opacity: 1,
			label: t("map.legend.tracerouteForward", "Traceroute →"),
		},
		{
			color: overlayColors.tracerouteReturn,
			width: 2,
			dashArray: "5,10",
			opacity: 1,
			label: t("map.legend.tracerouteReturn", "Traceroute ←"),
		},
		{
			color: overlayColors.mqttSegment,
			width: 2,
			dashArray: "3,6",
			opacity: 1,
			label: t("map.legend.mqtt", "MQTT"),
		},
	];

	// SNR quality items with both dot and line sample
	const snrItems = [
		{
			color: overlayColors.snrColors.good,
			label: t("map.legend.snrGood", "Good (> 10 dB)"),
		},
		{
			color: overlayColors.snrColors.medium,
			label: t("map.legend.snrMedium", "Medium (0–10 dB)"),
		},
		{
			color: overlayColors.snrColors.poor,
			label: t("map.legend.snrPoor", "Poor (< 0 dB)"),
		},
		{
			color: overlayColors.snrColors.noData,
			label: t("map.legend.snrNoData", "No data"),
		},
	];

	const formatTime = (timestamp: number) => {
		if (!positionHistory) return "";
		return formatDateTime(
			new Date(timestamp),
			positionHistory.timeFormat,
			positionHistory.dateFormat,
		);
	};

	return (
		<DraggableOverlay
			id="map-legend"
			defaultPosition={getDefaultPosition()}
			className="map-legend-wrapper"
		>
			<div className={`map-legend ${isCollapsed ? "collapsed" : ""}`}>
				<div className="legend-header">
					<span className="legend-title">{t("map.legend.hops")}</span>
					<button
						className="legend-collapse-btn"
						onClick={handleToggleCollapse}
						onMouseDown={(e) => e.stopPropagation()}
						title={isCollapsed ? "Expand legend" : "Collapse legend"}
					>
						{isCollapsed ? "▼" : "▲"}
					</button>
				</div>
				{!isCollapsed && (
					<>
						{legendItems.map((item, index) => (
							<div key={index} className="legend-item">
								<div
									className="legend-dot"
									style={{ backgroundColor: item.color }}
								/>
								<span className="legend-label">
									{item.translate ? t(item.label) : item.label}
								</span>
							</div>
						))}
						<div className="legend-divider" />
						<span className="legend-title">
							{t("map.legend.neighbors", "Neighbors")}
						</span>
						{/* Line style: solid = bidirectional, dashed = one-way */}
						<div className="legend-item">
							<svg width="24" height="12" className="legend-line-sample">
								<line
									x1="0"
									y1="6"
									x2="24"
									y2="6"
									stroke={overlayColors.neighborLine}
									strokeWidth={3}
								/>
							</svg>
							<span className="legend-label">
								{t("map.legend.bidirectional", "Bidirectional")}
							</span>
						</div>
						<div className="legend-item">
							<svg width="24" height="12" className="legend-line-sample">
								<line
									x1="0"
									y1="6"
									x2="24"
									y2="6"
									stroke={overlayColors.neighborLine}
									strokeWidth={2}
									strokeDasharray="5,5"
								/>
							</svg>
							<span className="legend-label">
								{t("map.legend.unidirectional", "One-way")}
							</span>
						</div>
						{/* SNR quality colors — shown as colored line + dot */}
						<span
							className="legend-sublabel"
							style={{
								fontSize: "0.7rem",
								color: "var(--ctp-subtext0)",
								marginTop: "2px",
							}}
						>
							{t("map.legend.signalColor", "Color = signal quality:")}
						</span>
						{snrItems.map((item) => (
							<div key={item.color} className="legend-item">
								<svg width="24" height="12" className="legend-line-sample">
									<line
										x1="0"
										y1="6"
										x2="24"
										y2="6"
										stroke={item.color}
										strokeWidth={3}
									/>
								</svg>
								<span className="legend-label">{item.label}</span>
							</div>
						))}
						<div className="legend-divider" />
						<span className="legend-title">
							{t("map.legend.otherLines", "Other Lines")}
						</span>
						{otherLineItems.map((item) => (
							<div key={item.label} className="legend-item">
								<svg width="24" height="12" className="legend-line-sample">
									<line
										x1="0"
										y1="6"
										x2="24"
										y2="6"
										stroke={item.color}
										strokeWidth={item.width}
										strokeDasharray={item.dashArray || "none"}
										strokeOpacity={item.opacity}
									/>
								</svg>
								<span className="legend-label">{item.label}</span>
							</div>
						))}
						{positionHistory && (
							<>
								<div className="legend-divider" />
								<span className="legend-title">
									{t("map.legend.positionHistory")}
								</span>
								<div className="legend-gradient-container">
									<div
										className="legend-gradient-bar"
										style={{
											background: `linear-gradient(to right, rgb(${overlayColors.positionHistoryOld.r}, ${overlayColors.positionHistoryOld.g}, ${overlayColors.positionHistoryOld.b}), rgb(${overlayColors.positionHistoryNew.r}, ${overlayColors.positionHistoryNew.g}, ${overlayColors.positionHistoryNew.b}))`,
										}}
									/>
									<div className="legend-gradient-labels">
										<span className="legend-gradient-label oldest">
											{t("map.legend.oldest")}
										</span>
										<span className="legend-gradient-label newest">
											{t("map.legend.newest")}
										</span>
									</div>
								</div>
								<div className="legend-time-labels">
									<span className="legend-time-label">
										{formatTime(positionHistory.oldestTime)}
									</span>
									<span className="legend-time-label">
										{formatTime(positionHistory.newestTime)}
									</span>
								</div>
							</>
						)}
					</>
				)}
			</div>
		</DraggableOverlay>
	);
};

export default MapLegend;
