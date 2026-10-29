/**
 * Mounts the configuration palette and owns its shortcut (#5182).
 *
 * Split from the modal so the two surfaces that can host it — the per-source
 * app and the standalone global settings page — each add one line rather than
 * repeating the state, the permission reads and the key handler.
 *
 * The shortcut is Ctrl/Cmd+comma, the conventional "preferences" chord. Ctrl+K
 * was already taken by message search, and the obvious palette chords collide
 * with the browser (Ctrl+Shift+P opens a private window in Firefox,
 * Ctrl+Shift+K opens its console).
 *
 * Only the shortcut and the open state live here. The palette itself
 * (`ConfigSearchPanel`: the section catalogue and the modal) is a lazy chunk
 * fetched on the first open, so hosting pages don't pay for it up front.
 */
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { lazyWithPreload } from '../../utils/lazyWithPreload';

const ConfigSearchPanel = lazyWithPreload(() => import('./ConfigSearchPanel'));

interface ConfigSearchHostProps {
  /** Base URL for the health probe, matching what the app already passes. */
  baseUrl?: string;
  /**
   * Lets the hosting surface open the palette from its own chrome (the sidebar
   * entry) as well as from the keyboard.
   */
  registerOpener?: (open: () => void) => void;
}

export const ConfigSearchHost: React.FC<ConfigSearchHostProps> = ({ baseUrl = '', registerOpener }) => {
  const [isOpen, setIsOpen] = useState(false);
  // Stays true after the first open, so closing keeps the panel mounted (and
  // its chunk loaded) rather than refetching on the next open.
  const [wasOpened, setWasOpened] = useState(false);

  useEffect(() => {
    if (isOpen) setWasOpened(true);
  }, [isOpen]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    registerOpener?.(open);
  }, [registerOpener, open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!isOpen && !wasOpened) return null;
  return (
    <Suspense fallback={null}>
      <ConfigSearchPanel baseUrl={baseUrl} isOpen={isOpen} onClose={close} />
    </Suspense>
  );
};

export default ConfigSearchHost;
