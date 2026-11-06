/**
 * @vitest-environment jsdom
 *
 * MeshCoreChannelMarker (#6228): the leading kind marker shown in front of a
 * channel name wherever MeshCore channels are listed. A globe for the public
 * channel, a padlock for a private channel, and nothing for a hashtag channel
 * (its leading `#` is its own marker).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreChannelMarker } from './MeshCoreChannelMarker';

describe('MeshCoreChannelMarker (#6228)', () => {
  it('renders a globe for the public channel (slot 0)', () => {
    const { container } = render(<MeshCoreChannelMarker id={0} name="Public" />);
    expect(container.querySelector('[data-ui-icon="globe"]')).not.toBeNull();
    expect(container.querySelector('[data-ui-icon="encrypted"]')).toBeNull();
  });

  it('renders a padlock for a private channel', () => {
    const { container } = render(<MeshCoreChannelMarker id={2} name="Family" />);
    expect(container.querySelector('[data-ui-icon="encrypted"]')).not.toBeNull();
    expect(container.querySelector('[data-ui-icon="globe"]')).toBeNull();
  });

  it('renders no icon for a hashtag channel — the # in the name is the marker', () => {
    const { container } = render(<MeshCoreChannelMarker id={1} name="#general" />);
    expect(container.querySelector('[data-ui-icon]')).toBeNull();
  });
});
