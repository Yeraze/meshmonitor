import { createContext } from 'react';

/**
 * Whether built-in automation sections should show AutomationEngineNote.
 * The per-source automation views (AutomationTab, MeshCoreAutomationsView)
 * provide `true` when the viewer can read the global `automations` resource,
 * the same gate as the sidebar's Automation Engine link. Defaults to false,
 * so a section rendered on its own shows no note.
 */
export const AutomationEngineNoteContext = createContext<boolean>(false);
