/**
 * Live-trace bus for the Automation Engine — the server side of the in-app
 * "view logs" debug feature.
 *
 * A per-automation, opt-in, time-bounded debug stream. While a rule is "armed"
 * (a browser clicked "Start logging" on it), the engine emits a trace verdict for
 * every event it evaluates against that rule — fired / filtered-out (+ reason) /
 * cooldown — so an operator can see *why* a rule did or did not run. Nothing is
 * persisted: payloads are pushed straight to the browser over Socket.io and held
 * only in a small capped client buffer. Sessions auto-expire (the WS layer caps
 * each arm at {@link MAX_TRACE_MS}); the engine prunes expired rules lazily.
 *
 * Decoupled from socket.io via an injectable sink so the engine and the bus stay
 * unit-testable without a live server; webSocketService registers the real sink
 * (a room emit) at init.
 */

/** Hard cap on how long a single trace session stays armed. */
export const MAX_TRACE_MS = 5 * 60_000;

export type AutomationTraceSink = (automationId: string, payload: unknown) => void;

interface TraceEntry {
  /** Socket ids currently interested in this rule (refcount). */
  sockets: Set<string>;
  /** Epoch-ms after which the session is considered expired. */
  expiry: number;
}

class AutomationTraceBus {
  private registry = new Map<string, TraceEntry>();
  private sink: AutomationTraceSink | null = null;

  /** Wire the delivery sink (webSocketService → room emit). Pass null to clear. */
  setSink(sink: AutomationTraceSink | null): void {
    this.sink = sink;
  }

  /** Arm a rule for tracing on behalf of a socket, until `expiry` (epoch ms).
   *  When multiple tabs trace the same rule the session lives until the latest
   *  requested expiry (`Math.max`) — "at least one listener still wants it". The
   *  WS layer caps each request at MAX_TRACE_MS, so this can't run unbounded. */
  arm(automationId: string, socketId: string, expiry: number): void {
    const entry = this.registry.get(automationId);
    if (entry) {
      entry.sockets.add(socketId);
      entry.expiry = Math.max(entry.expiry, expiry);
    } else {
      this.registry.set(automationId, { sockets: new Set([socketId]), expiry });
    }
  }

  /** Drop one socket's interest in a rule; removes the rule when no sockets remain. */
  disarm(automationId: string, socketId: string): void {
    const entry = this.registry.get(automationId);
    if (!entry) return;
    entry.sockets.delete(socketId);
    if (entry.sockets.size === 0) this.registry.delete(automationId);
  }

  /** Drop a disconnected socket from every rule it was tracing.
   *  Deleting the current key mid-iteration is safe: Map iteration is spec'd to
   *  tolerate deletion of already-visited/current entries (no skip). */
  disarmSocket(socketId: string): void {
    for (const [id, entry] of this.registry) {
      entry.sockets.delete(socketId);
      if (entry.sockets.size === 0) this.registry.delete(id);
    }
  }

  /** Cheap hot-path guard — non-zero only when ≥1 rule is currently armed. */
  activeCount(): number {
    return this.registry.size;
  }

  /** Whether a specific rule is armed and not expired (prunes on expiry). */
  isTracing(automationId: string, now: number = Date.now()): boolean {
    const entry = this.registry.get(automationId);
    if (!entry) return false;
    if (now > entry.expiry) {
      this.registry.delete(automationId);
      return false;
    }
    return true;
  }

  /** Push a trace payload for a rule, if it's armed (not expired) and a sink exists. */
  emit(automationId: string, payload: unknown, now: number = Date.now()): void {
    if (!this.sink) return;
    if (!this.isTracing(automationId, now)) return;
    this.sink(automationId, payload);
  }

  /** Test seam: forget all armed sessions. */
  reset(): void {
    this.registry.clear();
  }
}

export const automationTraceBus = new AutomationTraceBus();
