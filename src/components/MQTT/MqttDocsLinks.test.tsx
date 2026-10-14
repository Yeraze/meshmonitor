/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MqttDocsLinks } from './MqttDocsLinks';
import { MQTT_BROKER_DOCS_URL, MQTT_SETUP_GUIDE_URL } from '../../utils/mqttProxyLink';

describe('MqttDocsLinks (#5013)', () => {
  it('links the setup guide and the reference in a new tab', () => {
    render(<MqttDocsLinks />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([MQTT_SETUP_GUIDE_URL, MQTT_BROKER_DOCS_URL]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('adds a section link when given one', () => {
    render(<MqttDocsLinks section={{ href: 'https://meshmonitor.org/x#y', label: 'About this' }} />);
    expect(screen.getByRole('link', { name: 'About this' }).getAttribute('href')).toBe('https://meshmonitor.org/x#y');
  });

  it('points at pages that exist on the site', () => {
    expect(MQTT_SETUP_GUIDE_URL).toBe('https://meshmonitor.org/features/mqtt-setups');
    expect(MQTT_BROKER_DOCS_URL).toBe('https://meshmonitor.org/features/mqtt-broker');
  });
});
