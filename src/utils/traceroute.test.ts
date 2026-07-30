/**
 * Traceroute utility tests
 *
 * NOTE: Tests that require React rendering are skipped due to jsdom compatibility issues.
 * This test file focuses on testing formatNodeName which doesn't require rendering.
 *
 * The formatTracerouteRoute function's behavior will be validated through:
 * 1. Visual/manual testing in the browser
 * 2. System tests that exercise the full UI
 * 3. Post-refactoring tests once we fix the array mutation issues
 */
import { describe, it, expect } from 'vitest';
import { formatNodeName, formatTracerouteText } from './traceroute';
import { DeviceInfo } from '../types/device';

describe('Traceroute Utilities', () => {
  // Test data
  const mockNodes: DeviceInfo[] = [
    {
      nodeNum: 100,
      user: {
        id: '!64',
        longName: 'Node A',
        shortName: 'NDEA',
      },
    },
    {
      nodeNum: 200,
      user: {
        id: '!c8',
        longName: 'Node B',
        shortName: 'NDEB',
      },
    },
    {
      nodeNum: 300,
      user: {
        id: '!12c',
        longName: 'Repeater One',
        shortName: 'RPT1',
      },
    },
    {
      nodeNum: 600,
      user: {
        id: '!258',
        longName: 'Node 600',
        shortName: 'Node 600',
      },
    },
  ];

  describe('formatNodeName', () => {
    it('should format node with different long and short names', () => {
      const result = formatNodeName(100, mockNodes);
      expect(result).toBe('Node A [NDEA]');
    });

    it('should return only longName when shortName is the same', () => {
      const result = formatNodeName(600, mockNodes);
      expect(result).toBe('Node 600');
    });

    it('should return only longName when available and shortName is missing', () => {
      const nodesWithOnlyLongName: DeviceInfo[] = [
        {
          nodeNum: 700,
          user: {
            id: '!2bc',
            longName: 'Only Long',
          },
        },
      ];
      const result = formatNodeName(700, nodesWithOnlyLongName);
      expect(result).toBe('Only Long');
    });

    it('should return only shortName when longName is missing', () => {
      const nodesWithOnlyShortName: DeviceInfo[] = [
        {
          nodeNum: 800,
          user: {
            id: '!320',
            shortName: 'SHRT',
          },
        },
      ];
      const result = formatNodeName(800, nodesWithOnlyShortName);
      expect(result).toBe('SHRT');
    });

    it('should return hex ID when no user names are available', () => {
      const result = formatNodeName(999, mockNodes);
      expect(result).toBe('!3e7');
    });

    it('should handle node with no user object', () => {
      const nodesWithoutUser: DeviceInfo[] = [
        {
          nodeNum: 500,
        },
      ];
      const result = formatNodeName(500, nodesWithoutUser);
      expect(result).toBe('!1f4');
    });
  });

  /**
   * formatTracerouteRoute tests
   *
   * These tests are commented out due to jsdom compatibility issues.
   * The function will be tested after refactoring to fix the array mutation bugs.
   *
   * Known bugs to be fixed:
   * - Array mutation at lines 126-127 (fullPath.splice and snrArray.splice)
   * - SNR index misalignment at line 88
   * - Distance calculation issues at lines 135-149
   */

  /**
   * formatTracerouteText — plain-text leg rendering (traceroute copy-links
   * feature). Pure function, no React rendering, so unlike
   * formatTracerouteRoute above it's fully testable here.
   */
  describe('formatTracerouteText', () => {
    it('renders a full path with known SNR at each arrival hop', () => {
      // fromNum=100 -> 300 (arrival 40/4=10.0dB) -> toNum=200 (arrival 80/4=20.0dB)
      const result = formatTracerouteText('[300]', '[40,80]', 100, 200, mockNodes);
      expect(result).toBe('Node A [NDEA] → Repeater One [RPT1] (10.0 dB) → Node B [NDEB] (20.0 dB)');
    });

    it('never attaches an SNR suffix to the leg-start node', () => {
      const result = formatTracerouteText('[]', '[40]', 100, 200, mockNodes);
      // Direct hop: only the arrival at toNum (200) carries the sample.
      expect(result).toBe('Node A [NDEA] → Node B [NDEB] (10.0 dB)');
    });

    it('renders "(? dB)" for the firmware unknown-SNR sentinel (raw -128 / scaled -32)', () => {
      const result = formatTracerouteText('[300]', '[-128,40]', 100, 200, mockNodes);
      expect(result).toBe('Node A [NDEA] → Repeater One [RPT1] (? dB) → Node B [NDEB] (10.0 dB)');
    });

    it('omits the SNR suffix entirely for a hop with no sample', () => {
      const result = formatTracerouteText('[300]', '[]', 100, 200, mockNodes);
      expect(result).toBe('Node A [NDEA] → Repeater One [RPT1] → Node B [NDEB]');
    });

    it('renders BROADCAST_ADDR hops as "Unknown"', () => {
      const result = formatTracerouteText('[4294967295]', '[36]', 100, 200, mockNodes);
      expect(result).toBe('Node A [NDEA] → Unknown (9.0 dB) → Node B [NDEB]');
    });

    it('drops reserved/invalid intermediate node numbers but keeps their neighbor SNR aligned', () => {
      // route[0]=2 is reserved (<=3) and dropped; its paired snr[0]=10 is
      // dropped with it. route[1]=300 survives with snr[1]=20 (5.0dB). The
      // trailing snr[2]=30 (7.5dB) is toNum's own arrival sample.
      const result = formatTracerouteText('[2,300]', '[10,20,30]', 100, 200, mockNodes);
      expect(result).toBe('Node A [NDEA] → Repeater One [RPT1] (5.0 dB) → Node B [NDEB] (7.5 dB)');
    });

    it('returns null for a null route', () => {
      expect(formatTracerouteText(null, null, 100, 200, mockNodes)).toBeNull();
    });

    it("returns null for the string 'null' route", () => {
      expect(formatTracerouteText('null', null, 100, 200, mockNodes)).toBeNull();
    });

    it('returns null when both route and snr are empty arrays (#3622 not-yet-recorded guard)', () => {
      expect(formatTracerouteText('[]', '[]', 100, 200, mockNodes)).toBeNull();
      expect(formatTracerouteText('[]', null, 100, 200, mockNodes)).toBeNull();
    });

    it('returns null on malformed JSON instead of throwing', () => {
      expect(formatTracerouteText('not json', null, 100, 200, mockNodes)).toBeNull();
    });

    it('returns null when the parsed route is not an array', () => {
      expect(formatTracerouteText('{}', null, 100, 200, mockNodes)).toBeNull();
    });
  });
});
