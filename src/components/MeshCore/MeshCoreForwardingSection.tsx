/**
 * MeshCore wrapper for the shared Forwarding section (#5446). Loads this
 * source's channels and contacts (same endpoints the Auto-Responder and Timer
 * Triggers sections use) and hands them to ForwardingSection.
 */
import React, { useEffect, useState } from 'react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import {
  ForwardingSection,
  type ForwardingChannelOption,
  type ForwardingNodeOption,
} from '../forwarding/ForwardingSection';

interface MeshCoreForwardingSectionProps {
  baseUrl: string;
  sourceId: string;
  receiveOnly?: boolean;
}

export const MeshCoreForwardingSection: React.FC<MeshCoreForwardingSectionProps> = ({
  baseUrl,
  sourceId,
  receiveOnly = false,
}) => {
  const csrfFetch = useCsrfFetch();
  const [channels, setChannels] = useState<ForwardingChannelOption[]>([]);
  const [contacts, setContacts] = useState<ForwardingNodeOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`);
        if (!res.ok) return;
        const raw: unknown = await res.json();
        if (cancelled || !Array.isArray(raw)) return;
        setChannels(
          raw
            .filter((c): c is { id: number; name?: unknown } => typeof (c as { id?: unknown })?.id === 'number')
            .map(c => ({ index: c.id, name: String(c.name ?? '') }))
            .sort((a, b) => a.index - b.index),
        );
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/contacts`);
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled || !Array.isArray(raw?.data)) return;
        setContacts(
          (raw.data as Array<{ publicKey?: unknown; advName?: unknown; name?: unknown }>)
            .filter((c): c is { publicKey: string; advName?: unknown; name?: unknown } => typeof c?.publicKey === 'string')
            .map(c => ({
              id: c.publicKey,
              label: String(c.advName ?? c.name ?? c.publicKey.substring(0, 16)),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  return (
    <ForwardingSection
      baseUrl={baseUrl}
      sourceId={sourceId}
      channels={channels}
      nodes={contacts}
      receiveOnly={receiveOnly}
      saveBarId="meshcore-forwarding"
    />
  );
};

export default MeshCoreForwardingSection;
