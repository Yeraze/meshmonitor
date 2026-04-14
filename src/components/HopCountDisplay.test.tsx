/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HopCountDisplay from './HopCountDisplay';

describe('HopCountDisplay', () => {
  describe('Store & Forward indicator', () => {
    it('shows S&F icon when viaStoreForward is true', () => {
      render(<HopCountDisplay viaStoreForward={true} />);
      const sfIcon = screen.getByLabelText(/store_forward/i);
      expect(sfIcon).toBeDefined();
      expect(sfIcon.textContent).toBe('📦');
    });

    it('does not show S&F icon when viaStoreForward is false', () => {
      render(<HopCountDisplay viaStoreForward={false} />);
      const sfIcon = screen.queryByLabelText(/store_forward/i);
      expect(sfIcon).toBeNull();
    });

    it('does not show S&F icon when viaStoreForward is undefined', () => {
      render(<HopCountDisplay />);
      const sfIcon = screen.queryByLabelText(/store_forward/i);
      expect(sfIcon).toBeNull();
    });

    it('shows S&F icon alongside MQTT icon when both are true', () => {
      render(<HopCountDisplay viaStoreForward={true} viaMqtt={true} />);
      const sfIcon = screen.getByLabelText(/store_forward/i);
      const mqttIcon = screen.getByLabelText(/mqtt/i);
      expect(sfIcon).toBeDefined();
      expect(mqttIcon).toBeDefined();
    });

    it('shows S&F icon with hop count when hops are available', () => {
      render(<HopCountDisplay hopStart={7} hopLimit={5} viaStoreForward={true} />);
      const sfIcon = screen.getByLabelText(/store_forward/i);
      expect(sfIcon).toBeDefined();
      // Hop count should also render (i18n key in test env)
      expect(screen.getByText(/hops/i)).toBeDefined();
    });

    it('shows S&F icon with SNR/RSSI for direct messages (0 hops)', () => {
      render(
        <HopCountDisplay
          hopStart={7}
          hopLimit={7}
          rxSnr={9.5}
          rxRssi={-52}
          viaStoreForward={true}
        />
      );
      const sfIcon = screen.getByLabelText(/store_forward/i);
      expect(sfIcon).toBeDefined();
      expect(screen.getByText(/9\.5 dB/)).toBeDefined();
    });
  });

  describe('MQTT indicator', () => {
    it('shows MQTT icon when viaMqtt is true', () => {
      render(<HopCountDisplay viaMqtt={true} />);
      const mqttIcon = screen.getByLabelText(/mqtt/i);
      expect(mqttIcon).toBeDefined();
      expect(mqttIcon.textContent).toBe('🌐');
    });

    it('does not show MQTT icon when viaMqtt is false', () => {
      render(<HopCountDisplay viaMqtt={false} />);
      const mqttIcon = screen.queryByLabelText(/mqtt/i);
      expect(mqttIcon).toBeNull();
    });
  });

  describe('renders nothing when no data', () => {
    it('renders empty when no props provided', () => {
      const { container } = render(<HopCountDisplay />);
      expect(container.textContent).toBe('');
    });
  });
});
