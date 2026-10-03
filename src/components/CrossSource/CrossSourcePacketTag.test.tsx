/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CrossSourcePacketTag } from './CrossSourcePacketTag';
import type { PacketLog } from '../../types/packet';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const base: PacketLog = {
  id: 1, timestamp: 1, from_node: 1, portnum: 1, encrypted: false, sourceId: 'b', sourceName: 'Radio B',
};

describe('CrossSourcePacketTag (#5559)', () => {
  it('renders nothing for an untagged row', () => {
    const { container } = render(<CrossSourcePacketTag packet={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the origin source with transport in the tooltip', () => {
    render(<CrossSourcePacketTag packet={{ ...base, originSourceId: 'a', originSourceName: 'Radio A', crossSourceTransport: 'mqtt' }} />);
    const tag = screen.getByText('Radio A');
    expect(tag.closest('span')?.getAttribute('title')).toMatch(/Sent by our source Radio A, heard by Radio B over MQTT/);
  });

  it('labels a relay as inferred, and says when the byte is ambiguous', () => {
    const { rerender } = render(
      <CrossSourcePacketTag packet={{ ...base, likelyRelaySourceId: 'a', likelyRelaySourceName: 'Radio A', likelyRelayCandidateCount: 1, crossSourceTransport: 'rf' }} />,
    );
    const tag = screen.getByText('Radio A?');
    expect(tag.closest('span')?.getAttribute('title')).toMatch(/Likely relayed by our source Radio A \(inferred/);
    rerender(
      <CrossSourcePacketTag packet={{ ...base, likelyRelaySourceId: 'a', likelyRelaySourceName: 'Radio A', likelyRelayCandidateCount: 2, crossSourceTransport: 'rf' }} />,
    );
    expect(screen.getByText('Radio A?').closest('span')?.getAttribute('title')).toMatch(/2 of our sources share/);
  });
});
