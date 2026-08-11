/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HopCountDisplay from './HopCountDisplay';

describe('HopCountDisplay', () => {
  describe('Store & Forward indicator', () => {
    it('shows S&F icon when viaStoreForward is true', () => {
      render(<HopCountDisplay viaStoreForward={true} />);
      const sfIcon = screen.getByLabelText(/store_forward/i);
      expect(sfIcon).toBeDefined();
      expect(sfIcon.querySelector('[data-ui-icon="package"]')).toBeInTheDocument();
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
      expect(mqttIcon.querySelector('[data-ui-icon="network"]')).toBeInTheDocument();
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

  describe('clickability (#4657)', () => {
    it('multi-hop count is clickable even without a relay node', () => {
      const onClick = vi.fn();
      render(<HopCountDisplay hopStart={7} hopLimit={5} onClick={onClick} />);
      const span = screen.getByText(/hops/i);
      expect(span).toHaveStyle({ cursor: 'pointer' });
      fireEvent.click(span);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('is not clickable when no onClick handler is provided', () => {
      render(<HopCountDisplay hopStart={7} hopLimit={5} relayNode={0x42} />);
      const span = screen.getByText(/hops/i);
      expect(span).not.toHaveStyle({ cursor: 'pointer' });
    });

    it('0-hop signal display is clickable when onClick is provided', () => {
      const onClick = vi.fn();
      render(
        <HopCountDisplay hopStart={7} hopLimit={7} rxSnr={9.5} rxRssi={-52} onClick={onClick} />
      );
      const span = screen.getByText(/9\.5 dB/);
      expect(span).toHaveStyle({ cursor: 'pointer' });
      fireEvent.click(span);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
