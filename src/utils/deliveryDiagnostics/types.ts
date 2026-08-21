/**
 * Shared types for the "Delivery Details" diagnostics feature (#4816 Phase 1).
 *
 * Pure, framework-free data model. Everything here is i18n-free: fields carry
 * locale KEYS (translated by the consuming component with `t()`), plus
 * already-formatted literal values (numbers, hex, dB/dBm strings) where the
 * content isn't itself a translatable phrase. This keeps the describe
 * functions in `meshtasticDelivery.ts` / `meshcoreDelivery.ts` pure and
 * unit-testable without an i18n provider.
 */

/**
 * How trustworthy / how we know a given fact is.
 *
 * - `reported`  — the protocol/device told us this directly (an ACK field,
 *                 a wire value).
 * - `observed`  — MeshMonitor derived this from something it watched happen
 *                 (ingress attribution, re-flood correlation, timing).
 * - `inferred`  — MeshMonitor computed this from other reported values
 *                 (e.g. hopsUsed = hopStart − hopLimit) rather than reading
 *                 it directly off the wire.
 * - `unknown`   — we do not have this data at all. Never guess; render the
 *                 honest placeholder instead of a fabricated value.
 */
export type Provenance = 'reported' | 'observed' | 'inferred' | 'unknown';

/** Visual/semantic weight for a delivery status header. */
export type DeliveryTone = 'success' | 'error' | 'pending' | 'warning';

/**
 * Whether the message being described is one WE sent or one we RECEIVED
 * (#4816 follow-up — unified message-detail popup). Drives which sections a
 * describe builder emits: delivery/ACK/routing/identity are outbound-only,
 * while route/signal/packet-detail are reception facts meaningful on inbound
 * messages (and empty on our own sends).
 */
export type MessageDirection = 'sent' | 'received';

/**
 * A single labeled fact in the Delivery Details modal.
 *
 * `value` holds an already-formatted literal (e.g. "12 dB", "0x4a", "5") or
 * `null` when the data isn't available for this message. `valueKey` is used
 * instead of `value` when the content is one of a small translatable enum
 * (e.g. Direct/Relayed, Yes/No, RF/MQTT Bridge) — set at most one of the two.
 * `provenance` reflects the nominal source for this KIND of field (per the
 * Phase 1 field matrix), independent of whether this particular message
 * happens to carry a value.
 */
export interface DiagField {
  /** i18n key for the field's label. */
  labelKey: string;
  /** Literal, already-formatted display value, or null when unavailable. */
  value: string | null;
  /** i18n key for the value, used instead of `value` for translatable enums. */
  valueKey?: string;
  provenance: Provenance;
  /** Optional i18n key for a short muted note rendered under the value. */
  noteKey?: string;
}

/** A titled group of related fields, rendered as a block in the modal. */
export interface DeliverySection {
  /** i18n key for the section heading (e.g. "Route", "Signal"). */
  titleKey: string;
  fields: DiagField[];
}

/** A repeater that re-flooded an outgoing MeshCore message (heard-by list). */
export interface HeardByEntry {
  hash: string;
  name?: string | null;
  snr?: number | null;
}

/**
 * The full, pure description of an own-sent message's delivery state, ready
 * for a modal to render. Produced by `describeMeshtasticDelivery` /
 * `describeMeshCoreDelivery`.
 */
export interface DeliveryDescription {
  protocol: 'meshtastic' | 'meshcore';
  /** i18n key for the human-readable status label (header). */
  statusKey: string;
  tone: DeliveryTone;
  /** i18n key for the "what this means" explanation paragraph. */
  meaningKey: string;
  sections: DeliverySection[];
  /**
   * MeshCore-only: repeaters observed to have re-flooded this outgoing
   * channel message (Observed by MeshMonitor via re-flood correlation).
   * Undefined for Meshtastic descriptions and for MeshCore DMs.
   */
  heardBy?: HeardByEntry[];
}
