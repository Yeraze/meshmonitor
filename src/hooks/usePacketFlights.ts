/**
 * Live packet traffic on the map (#4835): ask the server for `packet:flight`
 * events on some sources while `enabled`, and hand each one to `onFlight`.
 *
 * Subscribes with `packet-flights:subscribe` when enabled (and again after a
 * reconnect, since the server forgets a socket's subscriptions when it
 * disconnects); unsubscribes when disabled, when the source list changes, and
 * on unmount. The server emits a source's flights only while some socket has
 * subscribed to it, so a map with the layer off costs the server nothing.
 */
import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import {
  PACKET_FLIGHT_EVENT,
  PACKET_FLIGHTS_SUBSCRIBE,
  PACKET_FLIGHTS_UNSUBSCRIBE,
  type PacketFlight,
} from '../types/packetFlight';

export interface UsePacketFlightsOptions {
  socket: Socket | null;
  enabled: boolean;
  sourceIds: string[];
  onFlight: (flight: PacketFlight) => void;
}

export function usePacketFlights({ socket, enabled, sourceIds, onFlight }: UsePacketFlightsOptions): void {
  const onFlightRef = useRef(onFlight);
  onFlightRef.current = onFlight;
  const key = [...new Set(sourceIds)].sort().join('|');

  useEffect(() => {
    if (!socket || !enabled || key === '') return;
    const ids = key.split('|');
    const wanted = new Set(ids);
    const subscribe = () => socket.emit(PACKET_FLIGHTS_SUBSCRIBE, ids);
    const handle = (flight: PacketFlight) => {
      if (flight && wanted.has(flight.sourceId)) onFlightRef.current(flight);
    };
    socket.on(PACKET_FLIGHT_EVENT, handle);
    // The server greets every (re)connection with `connected`.
    socket.on('connected', subscribe);
    if (socket.connected) subscribe();
    return () => {
      socket.off(PACKET_FLIGHT_EVENT, handle);
      socket.off('connected', subscribe);
      if (socket.connected) socket.emit(PACKET_FLIGHTS_UNSUBSCRIBE, ids);
    };
  }, [socket, enabled, key]);
}
