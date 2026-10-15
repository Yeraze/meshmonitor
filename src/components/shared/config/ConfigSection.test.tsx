/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { ConfigSection, ConfigHeaderCount } from './ConfigSection';
import { ConfigEmptyState } from './ConfigEmptyState';
import { ConfigField } from './ConfigField';
import { ReceiveOnlyNote } from './ReceiveOnlyNote';

describe('ConfigSection', () => {
  it('renders the title, description and body inside .settings-section', () => {
    const { container } = render(
      <ConfigSection title="Auto Thing" description="Does a thing.">
        <input aria-label="body input" />
      </ConfigSection>,
    );
    expect(screen.getByRole('heading', { name: /Auto Thing/ })).toBeInTheDocument();
    expect(screen.getByText('Does a thing.')).toBeInTheDocument();
    const body = container.querySelector('.settings-section');
    expect(body).not.toBeNull();
    expect(body!.contains(screen.getByLabelText('body input'))).toBe(true);
    // Header keeps the global class so mobile wrap rules still apply.
    expect(container.querySelector('.automation-section-header')).not.toBeNull();
  });

  it('shows the enable checkbox only when onEnabledChange is passed', () => {
    const { rerender } = render(<ConfigSection title="T" enabled />);
    expect(screen.queryByRole('checkbox')).toBeNull();

    const onChange = vi.fn();
    rerender(<ConfigSection title="T" enabled={false} onEnabledChange={onChange} enableLabel="Enable T" />);
    const box = screen.getByRole('checkbox', { name: 'Enable T' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('canWrite=false disables the enable toggle and every body control, not header actions', () => {
    render(
      <ConfigSection
        title="T"
        enabled
        onEnabledChange={() => {}}
        enableLabel="Enable T"
        canWrite={false}
        headerActions={<button type="button">Action</button>}
      >
        <input aria-label="field" />
        <select aria-label="pick"><option>a</option></select>
        <button type="button">Add</button>
      </ConfigSection>,
    );
    expect(screen.getByRole('checkbox', { name: 'Enable T' })).toBeDisabled();
    expect(screen.getByLabelText('field')).toBeDisabled();
    expect(screen.getByLabelText('pick')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Action' })).not.toBeDisabled();
  });

  it('leaves body controls enabled by default', () => {
    render(
      <ConfigSection title="T" onEnabledChange={() => {}} enabled>
        <input aria-label="field" />
      </ConfigSection>,
    );
    expect(screen.getByLabelText('field')).not.toBeDisabled();
    expect(screen.getByRole('checkbox')).not.toBeDisabled();
  });

  it('renders a docs link that opens in a new tab', () => {
    render(<ConfigSection title="T" docsUrl="https://meshmonitor.org/features/automation#x" />);
    const link = screen.getByRole('link', { name: 'View Documentation' });
    expect(link).toHaveAttribute('href', 'https://meshmonitor.org/features/automation#x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('omits the docs link when no docsUrl is given', () => {
    render(<ConfigSection title="T" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the neutral paused note when receiveOnly, and an override when given', () => {
    const { rerender } = render(<ConfigSection title="T" />);
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<ConfigSection title="T" receiveOnly />);
    expect(screen.getByRole('status')).toHaveTextContent(/cannot transmit/);

    rerender(<ConfigSection title="T" receiveOnly receiveOnlyNote="Custom paused text" />);
    expect(screen.getByRole('status')).toHaveTextContent('Custom paused text');
  });

  it('receiveOnly does not disable body controls', () => {
    render(
      <ConfigSection title="T" receiveOnly>
        <input aria-label="field" />
      </ConfigSection>,
    );
    expect(screen.getByLabelText('field')).not.toBeDisabled();
  });

  it('renders the notice slot and header actions', () => {
    render(
      <ConfigSection title="T" notice={<p>Heads up</p>} headerActions={<ConfigHeaderCount>3 triggers</ConfigHeaderCount>} />,
    );
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.getByText('3 triggers')).toBeInTheDocument();
  });

  it('fades the body only while disabled, and only when enabled is set', () => {
    const fadedClass = (c: HTMLElement) => c.querySelector('.settings-section')!.className;

    const off = render(<ConfigSection title="T" enabled={false} />);
    const offClass = fadedClass(off.container);
    off.unmount();

    const on = render(<ConfigSection title="T" enabled />);
    const onClass = fadedClass(on.container);
    on.unmount();

    const none = render(<ConfigSection title="T" />);
    const noneClass = fadedClass(none.container);
    none.unmount();

    const optedOut = render(<ConfigSection title="T" enabled={false} fadeWhenDisabled={false} />);
    const optedOutClass = fadedClass(optedOut.container);

    expect(offClass).not.toBe(onClass);
    expect(onClass).toBe(noneClass);
    expect(optedOutClass).toBe(onClass);
  });
});

describe('ConfigEmptyState / ConfigField / ReceiveOnlyNote', () => {
  it('renders the empty-state text', () => {
    render(<ConfigEmptyState>Nothing yet.</ConfigEmptyState>);
    expect(screen.getByText('Nothing yet.').tagName).toBe('P');
  });

  it('renders a setting-item row with label, description and control', () => {
    const { container } = render(
      <ConfigField label="Interval" description="How often." htmlFor="iv">
        <input id="iv" />
      </ConfigField>,
    );
    expect(container.querySelector('.setting-item')).not.toBeNull();
    expect(container.querySelector('.setting-description')).toHaveTextContent('How often.');
    expect(screen.getByLabelText(/Interval/)).toHaveAttribute('id', 'iv');
  });

  it('ReceiveOnlyNote renders nothing unless receiveOnly', () => {
    const { container, rerender } = render(<ReceiveOnlyNote />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ReceiveOnlyNote receiveOnly />);
    const note = screen.getByRole('status');
    expect(note.querySelector('svg')).not.toBeNull();
  });
});
