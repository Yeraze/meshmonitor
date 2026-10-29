import React, { ReactNode } from 'react';
import { useComposeDraft, ComposeDraftStore } from '../contexts/composeDraftStore';

interface ComposeDraftBinderProps {
  children: (draft: string, setDraft: ComposeDraftStore['set']) => ReactNode;
}

/**
 * Subscribes to the compose draft and hands it to `children`.
 *
 * App renders the Messages and Channels tabs through this so a keystroke
 * re-renders only the tab that hosts the compose box, not App and every
 * other context consumer.
 */
const ComposeDraftBinder: React.FC<ComposeDraftBinderProps> = ({ children }) => {
  const [draft, setDraft] = useComposeDraft();
  return <>{children(draft, setDraft)}</>;
};

export default ComposeDraftBinder;
