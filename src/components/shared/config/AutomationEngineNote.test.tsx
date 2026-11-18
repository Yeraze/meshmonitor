/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutomationEngineNote } from './AutomationEngineNote';
import { AutomationEngineNoteContext } from './automationEngineNoteContext';
import { EngineNoteHarness } from '../../../test/EngineNoteHarness';

const LINK_NAME = /build this in the Automation Engine|automation\.engine_note/i;

describe('AutomationEngineNote', () => {
  it('renders nothing without the context (default: hidden)', () => {
    const { container } = render(<AutomationEngineNote />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the viewer cannot read the Automation Engine', () => {
    render(<EngineNoteHarness visible={false}><AutomationEngineNote /></EngineNoteHarness>);
    expect(screen.queryByRole('link', { name: LINK_NAME })).toBeNull();
  });

  it('navigates to the Automation Engine page through the router', () => {
    render(<EngineNoteHarness><AutomationEngineNote /></EngineNoteHarness>);
    const link = screen.getByRole('link', { name: LINK_NAME });
    expect(link.getAttribute('href')).toBe('/automations');
    fireEvent.click(link);
    expect(screen.getByTestId('automation-engine-page')).toBeInTheDocument();
  });

  it('renders nothing outside a Router', () => {
    const { container } = render(
      <AutomationEngineNoteContext.Provider value={true}>
        <AutomationEngineNote />
      </AutomationEngineNoteContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not use the word "legacy"', () => {
    render(<EngineNoteHarness><AutomationEngineNote /></EngineNoteHarness>);
    expect(screen.getByRole('link', { name: LINK_NAME }).textContent).not.toMatch(/legacy/i);
  });
});
