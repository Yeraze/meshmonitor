/**
 * @vitest-environment jsdom
 *
 * Status Message config section layout.
 *
 * The "0/80" counter used to be absolutely positioned below the input, so it
 * escaped the section and sat on the next section's header ("Traffic
 * Management"). It now lives in normal flow beside the input, inside the
 * section, and the input fills the column instead of the global 200px.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusMessageConfigSection from './StatusMessageConfigSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));

function renderSection(nodeStatus = 'hello') {
  return render(
    <StatusMessageConfigSection
      nodeStatus={nodeStatus}
      setNodeStatus={vi.fn()}
      isDisabled={false}
      isSaving={false}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe('StatusMessageConfigSection layout', () => {
  it('keeps the character counter beside its input, inside the section', () => {
    const { container } = renderSection('hello');
    const input = screen.getByLabelText(/Node Status/);
    const counter = screen.getByTestId('status-message-counter');

    expect(counter.textContent).toBe('5/80');
    // Same wrapper as the input, so it cannot drift away from it.
    expect(counter.parentElement).toBe(input.parentElement);
    // Inside the Status Message section, not spilling into the next one.
    const section = container.querySelector('.settings-section');
    expect(section).not.toBeNull();
    expect(section!.contains(counter)).toBe(true);
  });

  it('does not position the counter absolutely', () => {
    renderSection();
    const counter = screen.getByTestId('status-message-counter');
    expect(counter.style.position).toBe('');
    expect(counter.style.bottom).toBe('');
    expect(counter.parentElement!.style.position).toBe('');
  });

  it('keeps the global setting-input class so the field matches its siblings', () => {
    renderSection();
    const input = screen.getByLabelText(/Node Status/);
    expect(input.classList.contains('setting-input')).toBe(true);
  });
});
