/**
 * @vitest-environment jsdom
 *
 * #5466 browser check: Escape did not close the Import Script modal. Only the
 * Cancel button or × did. The same was true of every Auto Responder dialog.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, fireEvent, screen } from '@testing-library/react';
import AutoResponderDialog from './AutoResponderDialog';
import ScriptTestModal from '../ScriptTestModal';

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

describe('AutoResponderDialog', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <AutoResponderDialog onClose={onClose} labelledBy="t">
        <h3 id="t">Import Script</h3>
        <button>Cancel</button>
      </AutoResponderDialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('t');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<AutoResponderDialog onClose={onClose}><p>x</p></AutoResponderDialog>);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ScriptTestModal', () => {
  const props = { onClose: vi.fn(), triggerType: 'auto-responder' as const, scriptPath: '/data/scripts/a.py', trigger: 'x', baseUrl: '' };

  it('closes on Escape while open', () => {
    const onClose = vi.fn();
    render(<ScriptTestModal {...props} isOpen onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not listen while closed', () => {
    const onClose = vi.fn();
    render(<ScriptTestModal {...props} isOpen={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('every Auto Responder dialog uses it', () => {
  it('Import, Export and Delete in AutoResponderSection', () => {
    const src = read('../AutoResponderSection.tsx');
    expect(src).toContain('<AutoResponderDialog onClose={closeImportModal}');
    expect(src).toContain('<AutoResponderDialog onClose={() => setShowExportModal(false)}');
    expect(src).toContain('<AutoResponderDialog onClose={closeDeleteModal}');
    // Escape runs the same cleanup as Cancel: the picker resets.
    const close = src.slice(src.indexOf('const closeImportModal'), src.indexOf('const closeDeleteModal'));
    expect(close).toContain("input.value = ''");
    // No hand-rolled overlays left.
    expect(src).not.toMatch(/position: 'fixed'/);
  });

  it('Remove Trigger in TriggerItem', () => {
    const src = read('TriggerItem.tsx');
    expect(src).toContain('<AutoResponderDialog');
    expect(src).toContain('onClose={() => setShowRemoveModal(false)}');
    expect(src).not.toMatch(/position: 'fixed'/);
  });
});
