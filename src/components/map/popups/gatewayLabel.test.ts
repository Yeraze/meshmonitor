import { describe, it, expect } from 'vitest';
import {
  buildGatewayNameIndex,
  resolveGatewayLabel,
  parseGatewayNodeNum,
  gatewayLegendText,
  gatewayChipText,
} from './gatewayLabel';

describe('gatewayLabel (#6386)', () => {
  const index = buildGatewayNameIndex([
    { nodeNum: 0x04e36b84, longName: 'Hilltop Gateway', shortName: 'HILL' },
    { nodeNum: 0x0000beef, user: { longName: 'Nested Shape', shortName: 'NEST' } },
    { nodeNum: 0x9e80e848, longName: 'Node !9e80e848', shortName: 'e848' },
    { nodeNum: 0x11111111, longName: 'Only Long', shortName: '' },
  ]);

  it('resolves names from gatewayNodeNum', () => {
    const label = resolveGatewayLabel('!04e36b84', 0x04e36b84, index);
    expect(label).toEqual({ id: '!04e36b84', longName: 'Hilltop Gateway', shortName: 'HILL' });
    expect(gatewayLegendText(label)).toBe('Hilltop Gateway (!04e36b84)');
    expect(gatewayChipText(label)).toBe('HILL');
  });

  it('parses the nodeNum from the hex id when gatewayNodeNum is null', () => {
    const label = resolveGatewayLabel('!0000beef', null, index);
    expect(label.longName).toBe('Nested Shape');
    expect(gatewayChipText(label)).toBe('NEST');
  });

  it('treats placeholder names as unknown and falls back to the raw id', () => {
    const label = resolveGatewayLabel('!9e80e848', 0x9e80e848, index);
    expect(label.longName).toBeNull();
    expect(gatewayLegendText(label)).toBe('!9e80e848');
    expect(gatewayChipText(label)).toBe('!9e80e848');
  });

  it('falls back to the raw id when the gateway is not in the viewer node list', () => {
    const label = resolveGatewayLabel('!deadbeef', 0xdeadbeef, index);
    expect(gatewayLegendText(label)).toBe('!deadbeef');
    expect(gatewayChipText(label)).toBe('!deadbeef');
  });

  it('falls back to the raw id with no index (popup outside a provider)', () => {
    expect(gatewayChipText(resolveGatewayLabel('!04e36b84', 0x04e36b84, null))).toBe('!04e36b84');
  });

  it('uses the long name on the chip when there is no short name', () => {
    expect(gatewayChipText(resolveGatewayLabel('!11111111', null, index))).toBe('Only Long');
  });

  it('handles nodeNums above 2^31 (BIGINT rows as strings)', () => {
    const big = buildGatewayNameIndex([{ nodeNum: '4026531841', longName: 'Big One' }]);
    expect(resolveGatewayLabel('!f0000001', null, big).longName).toBe('Big One');
  });

  it('rejects non-hex ids', () => {
    expect(parseGatewayNodeNum('gateway-x')).toBeNull();
    expect(parseGatewayNodeNum('!04e36b84')).toBe(0x04e36b84);
  });
});
