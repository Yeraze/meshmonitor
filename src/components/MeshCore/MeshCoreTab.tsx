/**
 * MeshCoreTab — legacy entry point.
 *
 * The single-file tab has been replaced by the multi-pane MeshCorePage
 * (see ./MeshCorePage.tsx and docs/research/meshcore-page-redesign.md).
 * This file re-exports the new page under the old name so existing imports
 * (`import { MeshCoreTab } from './components/MeshCore'`) keep working.
 */
export { MeshCorePage as MeshCoreTab, MeshCorePage as default } from './MeshCorePage';
