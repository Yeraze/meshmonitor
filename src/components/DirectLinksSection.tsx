/**
 * DirectLinksSection — Shows direct radio link (neighbor info) for a given node.
 *
 * Shared between MessagesTab and NodeDetailsBlock.
 * Displays neighbor list sorted by SNR, with request/purge controls.
 */

import {
	ArrowLeftRight,
	ChevronDown,
	ChevronRight,
	Radio,
	RefreshCw,
	Trash2,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMapContext } from "../contexts/MapContext";
import { useSettings } from "../contexts/SettingsContext";
import apiService from "../services/api";
import type { ResourceType } from "../types/permission";
import { calculateDistance, formatDistance } from "../utils/distance";
import { useToast } from "./ToastContainer";

const COLLAPSE_THRESHOLD = 10;

interface DirectLinksSectionProps {
	nodeNum: number;
	nodeId: string; // hex node id like "!abcdef01"
	hopsAway?: number | null;
	isLocalNode?: boolean;
	connectionStatus: string;
	hasPermission: (resource: ResourceType, action: "read" | "write") => boolean;
	onRequestNeighborInfo: (nodeId: string) => Promise<void>;
	neighborInfoLoading: string | null;
	onNodeClick?: (nodeId: string) => void;
}

function getSnrColor(
	snr: number | null | undefined,
	snrColors: { good: string; medium: string; poor: string; noData: string },
): string {
	if (snr == null) return snrColors.noData;
	if (snr > 10) return snrColors.good;
	if (snr >= 0) return snrColors.medium;
	return snrColors.poor;
}

function getSnrLabel(snr: number | null | undefined): string {
	if (snr == null) return "—";
	return `${snr.toFixed(1)} dB`;
}

const DirectLinksSection: React.FC<DirectLinksSectionProps> = ({
	nodeNum,
	nodeId,
	hopsAway,
	isLocalNode = false,
	connectionStatus,
	hasPermission,
	onRequestNeighborInfo,
	neighborInfoLoading,
	onNodeClick,
}) => {
	const { t } = useTranslation();
	const { neighborInfo, setNeighborInfo } = useMapContext();
	const { distanceUnit, overlayColors } = useSettings();
	const { showToast } = useToast();

	const [isCollapsed, setIsCollapsed] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [purgingNeighbors, setPurgingNeighbors] = useState(false);
	const [rateLimitCountdown, setRateLimitCountdown] = useState(0);

	// Filter neighbors for this node, sorted by SNR (best first)
	const nodeNeighbors = useMemo(
		() =>
			(neighborInfo || [])
				.filter((ni) => ni.nodeNum === nodeNum)
				.sort((a, b) => {
					if (a.snr == null && b.snr == null) return 0;
					if (a.snr == null) return 1;
					if (b.snr == null) return -1;
					return b.snr - a.snr;
				}),
		[neighborInfo, nodeNum],
	);

	// Data age from most recent neighbor info
	const mostRecent =
		nodeNeighbors.length > 0
			? Math.max(...nodeNeighbors.map((n) => n.timestamp))
			: 0;
	const ageMs = mostRecent > 0 ? Date.now() - mostRecent : 0;
	const ageMin = Math.floor(ageMs / 60000);
	const ageStr =
		mostRecent === 0
			? ""
			: ageMin < 60
				? `${ageMin}m ago`
				: `${Math.floor(ageMin / 60)}h ago`;

	// Eligible for requesting: local node or 0-hop
	const isEligible =
		isLocalNode || (hopsAway != null && Number(hopsAway) === 0);

	// Countdown timer for rate limiting — only start/stop when countdown transitions
	const isCountdownActive = rateLimitCountdown > 0;
	useEffect(() => {
		if (!isCountdownActive) return;
		const id = setInterval(() => {
			setRateLimitCountdown((prev) => {
				if (prev <= 1) {
					clearInterval(id);
					return 0;
				}
				return prev - 1;
			});
		}, 1000);
		return () => clearInterval(id);
	}, [isCountdownActive]);

	const handleRequest = useCallback(async () => {
		try {
			await onRequestNeighborInfo(nodeId);
			// Set a default countdown (server may return retryAfter)
			setRateLimitCountdown(180);
		} catch {
			// Error handled upstream
		}
	}, [nodeId, onRequestNeighborInfo]);

	const handlePurge = useCallback(async () => {
		if (purgingNeighbors) return;
		const confirmed = window.confirm(
			t(
				"messages.confirm_purge_neighbors",
				"Are you sure you want to delete all neighbor info for this node?",
			),
		);
		if (!confirmed) return;

		setPurgingNeighbors(true);
		try {
			await apiService.purgeNeighborInfo(nodeId);
			setNeighborInfo(neighborInfo.filter((n) => n.nodeNum !== nodeNum));
			showToast(
				t("messages.neighbor_info_purged", "Neighbor info purged successfully"),
				"success",
			);
		} catch {
			showToast(
				t(
					"messages.neighbor_info_purge_failed",
					"Failed to purge neighbor info",
				),
				"error",
			);
		} finally {
			setPurgingNeighbors(false);
		}
	}, [
		purgingNeighbors,
		nodeId,
		nodeNum,
		neighborInfo,
		setNeighborInfo,
		showToast,
		t,
	]);

	// Determine visible neighbors (collapse if > threshold)
	const shouldCollapse = nodeNeighbors.length > COLLAPSE_THRESHOLD && !showAll;
	const visibleNeighbors = shouldCollapse
		? nodeNeighbors.slice(0, COLLAPSE_THRESHOLD)
		: nodeNeighbors;

	const formatCountdown = (seconds: number) => {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return `${m}:${s.toString().padStart(2, "0")}`;
	};

	if (nodeNeighbors.length === 0 && !isEligible) {
		return null; // Nothing to show and can't request
	}

	return (
		<div className="direct-links-section">
			{/* Header */}
			{/* biome-ignore lint/a11y/useSemanticElements: complex flex layout not suitable for <button> */}
			<div
				className="direct-links-header"
				role="button"
				tabIndex={0}
				onClick={() => setIsCollapsed(!isCollapsed)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setIsCollapsed(!isCollapsed);
					}
				}}
				style={{
					display: "flex",
					alignItems: "center",
					gap: "0.5rem",
					cursor: "pointer",
					padding: "0.5rem 0",
					userSelect: "none",
					flexWrap: "wrap",
				}}
			>
				{isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
				<Radio size={16} />
				<strong>{t("direct_links.title", "Direct Radio Links")}</strong>
				{nodeNeighbors.length > 0 && (
					<span
						style={{
							fontSize: "0.85em",
							color: "var(--ctp-subtext0)",
							backgroundColor: "var(--ctp-surface0)",
							padding: "0.1rem 0.4rem",
							borderRadius: "8px",
						}}
					>
						{nodeNeighbors.length}
					</span>
				)}
				{ageStr && (
					<span style={{ fontSize: "0.85em", color: "var(--ctp-subtext0)" }}>
						({ageStr})
					</span>
				)}
				{/* Refresh button — inline next to title */}
				{hasPermission("traceroute", "write") && isEligible && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							handleRequest();
						}}
						onKeyDown={(e) => e.stopPropagation()}
						disabled={
							connectionStatus !== "connected" ||
							neighborInfoLoading === nodeId ||
							rateLimitCountdown > 0
						}
						title={
							rateLimitCountdown > 0
								? t(
										"direct_links.request_limited",
										"Request available in {{time}}",
										{ time: formatCountdown(rateLimitCountdown) },
									)
								: t("messages.request_neighbor_info", "Request Neighbor Info")
						}
						style={{
							padding: "0.2rem 0.4rem",
							fontSize: "0.8em",
							backgroundColor:
								rateLimitCountdown > 0
									? "var(--ctp-surface0)"
									: "var(--ctp-blue)",
							color:
								rateLimitCountdown > 0
									? "var(--ctp-subtext0)"
									: "var(--ctp-base)",
							border: "1px solid var(--ctp-surface1)",
							borderRadius: "4px",
							cursor:
								connectionStatus !== "connected" ||
								neighborInfoLoading === nodeId ||
								rateLimitCountdown > 0
									? "not-allowed"
									: "pointer",
							opacity:
								connectionStatus !== "connected" ||
								neighborInfoLoading === nodeId ||
								rateLimitCountdown > 0
									? 0.6
									: 1,
							display: "flex",
							alignItems: "center",
							gap: "0.25rem",
						}}
					>
						{neighborInfoLoading === nodeId ? (
							<span className="spinner" />
						) : (
							<RefreshCw size={12} />
						)}
						{rateLimitCountdown > 0
							? formatCountdown(rateLimitCountdown)
							: null}
					</button>
				)}
				{/* Purge button — inline next to refresh */}
				{nodeNeighbors.length > 0 && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							handlePurge();
						}}
						onKeyDown={(e) => e.stopPropagation()}
						disabled={purgingNeighbors}
						title={t(
							"messages.purge_neighbors_tooltip",
							"Delete neighbor info for this node",
						)}
						style={{
							padding: "0.2rem 0.4rem",
							fontSize: "0.8em",
							backgroundColor: "var(--ctp-surface0)",
							color: "var(--ctp-text)",
							border: "1px solid var(--ctp-surface1)",
							borderRadius: "4px",
							cursor: purgingNeighbors ? "not-allowed" : "pointer",
							opacity: purgingNeighbors ? 0.6 : 1,
							display: "flex",
							alignItems: "center",
							gap: "0.25rem",
						}}
					>
						{purgingNeighbors ? (
							<span className="spinner" />
						) : (
							<Trash2 size={12} />
						)}
					</button>
				)}
			</div>

			{/* Neighbor list */}
			{!isCollapsed && (
				<div className="direct-links-list">
					{nodeNeighbors.length === 0 ? (
						<div
							style={{
								padding: "0.5rem",
								color: "var(--ctp-subtext0)",
								fontSize: "0.9em",
								fontStyle: "italic",
							}}
						>
							{t(
								"direct_links.no_data",
								"No neighbor data available. Click refresh to request.",
							)}
						</div>
					) : (
						<>
							{visibleNeighbors.map((neighbor, idx) => {
								let distStr = "";
								if (
									neighbor.nodeLatitude != null &&
									neighbor.nodeLongitude != null &&
									neighbor.neighborLatitude != null &&
									neighbor.neighborLongitude != null
								) {
									const distKm = calculateDistance(
										neighbor.nodeLatitude,
										neighbor.nodeLongitude,
										neighbor.neighborLatitude,
										neighbor.neighborLongitude,
									);
									distStr = formatDistance(distKm, distanceUnit);
								}

								return (
									<div
										key={`${neighbor.nodeNum}-${neighbor.neighborNodeNum}`}
										className="direct-links-item"
										style={{
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											padding: "0.35rem 0.5rem",
											borderBottom:
												idx < visibleNeighbors.length - 1
													? "1px solid var(--ctp-surface0)"
													: "none",
											fontSize: "0.9em",
										}}
									>
										{/* Left: name + bidirectional badge */}
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "0.4rem",
												minWidth: 0,
											}}
										>
											{neighbor.bidirectional && (
												<span
													title={t(
														"direct_links.bidirectional",
														"Bidirectional",
													)}
												>
													<ArrowLeftRight
														size={13}
														style={{ color: "var(--ctp-green)", flexShrink: 0 }}
													/>
												</span>
											)}
											{/* biome-ignore lint/a11y/noStaticElementInteractions: conditional interactivity based on onNodeClick */}
											<span
												role={onNodeClick ? "button" : undefined}
												tabIndex={onNodeClick ? 0 : undefined}
												style={{
													cursor: onNodeClick ? "pointer" : "default",
													color: onNodeClick
														? "var(--ctp-blue)"
														: "var(--ctp-text)",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
												onClick={() =>
													onNodeClick?.(
														neighbor.neighborNodeId ||
															`!${neighbor.neighborNodeNum.toString(16).padStart(8, "0")}`,
													)
												}
												onKeyDown={(e) => {
													if (
														(e.key === "Enter" || e.key === " ") &&
														onNodeClick
													) {
														e.preventDefault();
														onNodeClick(
															neighbor.neighborNodeId ||
																`!${neighbor.neighborNodeNum.toString(16).padStart(8, "0")}`,
														);
													}
												}}
												title={
													neighbor.neighborNodeId ||
													`!${neighbor.neighborNodeNum.toString(16).padStart(8, "0")}`
												}
											>
												{neighbor.neighborName ||
													neighbor.neighborNodeId ||
													`!${neighbor.neighborNodeNum.toString(16).padStart(8, "0")}`}
											</span>
										</div>

										{/* Right: SNR + distance */}
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "0.5rem",
												color: "var(--ctp-subtext0)",
												flexShrink: 0,
												fontSize: "0.85em",
											}}
										>
											{neighbor.snr != null && (
												<span
													style={{
														color: getSnrColor(
															neighbor.snr,
															overlayColors.snrColors,
														),
														fontWeight: 600,
													}}
												>
													{getSnrLabel(neighbor.snr)}
												</span>
											)}
											{distStr && <span>{distStr}</span>}
										</div>
									</div>
								);
							})}

							{/* Show all / collapse toggle */}
							{nodeNeighbors.length > COLLAPSE_THRESHOLD && (
								<button
									type="button"
									onClick={() => setShowAll(!showAll)}
									style={{
										width: "100%",
										padding: "0.3rem",
										fontSize: "0.85em",
										color: "var(--ctp-blue)",
										backgroundColor: "transparent",
										border: "none",
										cursor: "pointer",
										textAlign: "center",
									}}
								>
									{showAll
										? t("direct_links.show_less", "Show less")
										: t("direct_links.show_all", "Show all ({{count}})", {
												count: nodeNeighbors.length,
											})}
								</button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
};

export default DirectLinksSection;
