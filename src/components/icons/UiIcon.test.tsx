/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandIcon } from './BrandIcon';
import { UiIcon, UI_ICON_DEFINITIONS } from './UiIcon';

describe('UiIcon', () => {
  it('renders Lucide by default without a SettingsProvider', () => {
    const { container } = render(<UiIcon name="delete" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders the registered emoji in emoji mode', () => {
    const { container } = render(<UiIcon name="delete" iconStyle="emoji" size={20} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe(UI_ICON_DEFINITIONS.delete.emoji);
  });

  it('keeps decorative icons hidden from assistive technology', () => {
    const { container } = render(<UiIcon name="info" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('provides an accessible name when used as a standalone status', () => {
    const { container } = render(<UiIcon name="alert" title="Warning" />);
    const icon = container.querySelector('[role="img"]');
    expect(icon?.getAttribute('aria-label')).toBe('Warning');
  });
});

describe('BrandIcon', () => {
  it('renders the Simple Icons GitHub mark', () => {
    const { container } = render(<BrandIcon brand="github" size={20} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(container.querySelector('path')?.getAttribute('d')).toBeTruthy();
  });
});
