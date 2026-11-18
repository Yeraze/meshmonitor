/**
 * Test harness for AutomationEngineNote: a MemoryRouter at `/` with the note
 * turned on, plus a marker route at `/automations` so a test can click the
 * note's link and see that navigation landed on the Automation Engine page.
 */
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AutomationEngineNoteContext } from '../components/shared/config/automationEngineNoteContext';

export const EngineNoteHarness: React.FC<{ children: React.ReactNode; visible?: boolean }> = ({
  children,
  visible = true,
}) => (
  <MemoryRouter initialEntries={['/']}>
    <AutomationEngineNoteContext.Provider value={visible}>
      <Routes>
        <Route path="/" element={<>{children}</>} />
        <Route path="/automations" element={<div data-testid="automation-engine-page" />} />
      </Routes>
    </AutomationEngineNoteContext.Provider>
  </MemoryRouter>
);
