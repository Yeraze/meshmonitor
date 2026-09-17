/**
 * @vitest-environment jsdom
 *
 * Shared module-availability gate (#5065). The device's
 * DeviceMetadata.excluded_modules bitmask says which module configs a firmware
 * build left out; an unknown bitmask must leave every section alone.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModuleAvailabilityGate from './ModuleAvailabilityGate';

describe('ModuleAvailabilityGate (#5065)', () => {
  it('renders the section untouched when the device reports it available', () => {
    render(
      <ModuleAvailabilityGate available={true} moduleName="MQTT">
        <button>Save MQTT</button>
      </ModuleAvailabilityGate>
    );
    expect(screen.getByRole('button', { name: 'Save MQTT' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('fails open when the device never reported a bitmask', () => {
    render(
      <ModuleAvailabilityGate moduleName="MQTT">
        <button>Save MQTT</button>
      </ModuleAvailabilityGate>
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the section visible but notices and disables it when excluded', () => {
    const { container } = render(
      <ModuleAvailabilityGate available={false} moduleName="Paxcounter">
        <button>Save Paxcounter</button>
      </ModuleAvailabilityGate>
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    // The controls stay in the DOM — a section that vanishes reads as a bug.
    expect(screen.getByRole('button', { name: 'Save Paxcounter' })).toBeInTheDocument();
    expect(container.querySelector('[class*="disabledControls"]')).not.toBeNull();
  });
});
