/**
 * @vitest-environment jsdom
 *
 * useCoverageData (#5277, Phase 1 WP4) — the three Coverage Report query
 * hooks. `analysisApi`'s fetchers are mocked directly since they already
 * unwrap `body.data` (tested at that layer); these tests cover the hooks'
 * own behavior: the `/receptions` page loop stopping on `hasMore: false`,
 * capping at `COVERAGE_MAX_PAGES` with `truncated: true`, and each hook
 * returning the unwrapped shape the fetcher gave it.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCoverageReceivers,
  useCoverageSenders,
  useCoverageReceptions,
  COVERAGE_MAX_PAGES,
} from './useCoverageData';
import {
  fetchCoverageReceivers,
  fetchCoverageSenders,
  fetchCoverageReceptionsPage,
} from '../services/analysisApi';
import type { CoverageReceptionDto } from '../types/coverage';

vi.mock('../services/analysisApi', () => ({
  fetchCoverageReceivers: vi.fn(),
  fetchCoverageSenders: vi.fn(),
  fetchCoverageReceptionsPage: vi.fn(),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

function makeReception(id: number): CoverageReceptionDto {
  return {
    id,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    receiverLatitude: 26.1,
    receiverLongitude: -80.2,
    senderId: '!bbbbbbbb',
    senderNodeNum: 2,
    packetKey: String(id),
    packetId: id,
    pathKey: 'r0:h0',
    latitude: 26.1,
    longitude: -80.2,
    altitude: null,
    precisionBits: null,
    snr: 5,
    rssi: -80,
    hopStart: 0,
    hopLimit: 0,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: null,
    channel: 0,
    rxTime: 1_700_000_000,
    receivedAt: 1_700_000_000_000 + id,
  };
}

describe('useCoverageData', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('useCoverageReceivers', () => {
    it('unwraps the fetcher result', async () => {
      vi.mocked(fetchCoverageReceivers).mockResolvedValue({
        receivers: [
          {
            sourceId: 'src-a',
            sourceName: 'Source A',
            protocol: 'meshtastic',
            receiverKind: 'local',
            receiverId: '!aaaaaaaa',
            receiverNodeNum: 1,
            longName: 'Receiver One',
            shortName: 'R1',
            latitude: 26.1,
            longitude: -80.2,
            lastReceivedAt: 1_700_000_000_000,
            receptionCount: 4,
          },
        ],
        retentionDays: 7,
        mqttSources: [{ sourceId: 'src-mqtt', sourceName: 'MQTT Source', recordingEnabled: true }],
      });

      const { result } = renderHook(() => useCoverageReceivers([]), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(result.current.data?.retentionDays).toBe(7);
      expect(result.current.data?.receivers).toHaveLength(1);
      expect(result.current.data?.mqttSources).toEqual([
        { sourceId: 'src-mqtt', sourceName: 'MQTT Source', recordingEnabled: true },
      ]);
    });
  });

  describe('useCoverageSenders', () => {
    it('unwraps the fetcher result', async () => {
      vi.mocked(fetchCoverageSenders).mockResolvedValue({
        senders: [
          { senderId: '!bbbbbbbb', senderNodeNum: 2, longName: null, shortName: null, fixCount: 3, lastReceivedAt: 1 },
        ],
        truncated: false,
      });

      const { result } = renderHook(
        () => useCoverageSenders({ sources: [], sinceMs: 0, untilMs: 1 }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(result.current.data?.senders).toHaveLength(1);
      expect(result.current.data?.truncated).toBe(false);
    });
  });

  describe('useCoverageReceptions', () => {
    it('stops paging once hasMore is false', async () => {
      vi.mocked(fetchCoverageReceptionsPage).mockResolvedValueOnce({
        items: [makeReception(1), makeReception(2)],
        pageSize: 1000,
        hasMore: false,
        nextCursor: null,
      });

      const { result } = renderHook(
        () => useCoverageReceptions({ sources: [], sinceMs: 0, untilMs: 1 }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(1);
      expect(result.current.data?.items).toHaveLength(2);
      expect(result.current.data?.truncated).toBe(false);
    });

    it('follows nextCursor across pages and concatenates items', async () => {
      vi.mocked(fetchCoverageReceptionsPage)
        .mockResolvedValueOnce({
          items: [makeReception(1)],
          pageSize: 1000,
          hasMore: true,
          nextCursor: 'cursor-1',
        })
        .mockResolvedValueOnce({
          items: [makeReception(2)],
          pageSize: 1000,
          hasMore: false,
          nextCursor: null,
        });

      const { result } = renderHook(
        () => useCoverageReceptions({ sources: [], sinceMs: 0, untilMs: 1 }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(2);
      expect(fetchCoverageReceptionsPage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor-1' }),
      );
      expect(result.current.data?.items.map((i) => i.id)).toEqual([1, 2]);
      expect(result.current.data?.truncated).toBe(false);
    });

    it('caps at COVERAGE_MAX_PAGES and reports truncated:true when more remain', async () => {
      vi.mocked(fetchCoverageReceptionsPage).mockImplementation(async ({ cursor }: any) => {
        const pageNum = cursor ? Number(cursor.replace('cursor-', '')) : 0;
        return {
          items: [makeReception(pageNum)],
          pageSize: 1000,
          hasMore: true,
          nextCursor: `cursor-${pageNum + 1}`,
        };
      });

      const { result } = renderHook(
        () => useCoverageReceptions({ sources: [], sinceMs: 0, untilMs: 1 }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(COVERAGE_MAX_PAGES);
      expect(result.current.data?.items).toHaveLength(COVERAGE_MAX_PAGES);
      expect(result.current.data?.truncated).toBe(true);
    });

    it('does not fetch when disabled', () => {
      renderHook(
        () => useCoverageReceptions({ sources: [], sinceMs: 0, untilMs: 1 }, false),
        { wrapper },
      );
      expect(fetchCoverageReceptionsPage).not.toHaveBeenCalled();
    });

    it('encodes receiverFilter to the wire grammar for the fetcher', async () => {
      vi.mocked(fetchCoverageReceptionsPage).mockResolvedValueOnce({
        items: [makeReception(1)],
        pageSize: 1000,
        hasMore: false,
        nextCursor: null,
      });

      const { result } = renderHook(
        () =>
          useCoverageReceptions({
            sources: [],
            sinceMs: 0,
            untilMs: 1,
            receiverFilter: [{ sourceId: 'src-a', mode: 'include', receiverIds: ['!aaaaaaaa'] }],
          }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(fetchCoverageReceptionsPage).toHaveBeenCalledWith(
        expect.objectContaining({ receiversQuery: 'src-a:+!aaaaaaaa' }),
      );
    });

    it('drops rows whose composite key is not in clientSideFilter, and queries with no wire receiver filter', async () => {
      vi.mocked(fetchCoverageReceptionsPage).mockResolvedValueOnce({
        items: [makeReception(1), { ...makeReception(2), receiverId: '!other', sourceId: 'src-b' }],
        pageSize: 1000,
        hasMore: false,
        nextCursor: null,
      });

      const { result } = renderHook(
        () =>
          useCoverageReceptions({
            sources: [],
            sinceMs: 0,
            untilMs: 1,
            clientSideFilter: new Set(['src-a|!aaaaaaaa']),
          }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toBeDefined());

      expect(fetchCoverageReceptionsPage).toHaveBeenCalledWith(
        expect.objectContaining({ receiversQuery: undefined }),
      );
      expect(result.current.data?.items.map((i) => i.id)).toEqual([1]);
    });
  });
});
