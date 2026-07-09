/**
 * ThemesRepository Tests (SQLite)
 *
 * Basic coverage for getAllCustomThemes, getCustomThemeBySlug,
 * createCustomTheme, updateCustomTheme, deleteCustomTheme.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ThemesRepository } from './themes.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('ThemesRepository - SQLite', () => {
  let repo: ThemesRepository;
  let close: () => void;

  beforeEach(() => {
    const t = createTestDb();
    repo = new ThemesRepository(t.db, 'sqlite');
    close = t.close;
  });

  afterEach(() => {
    close();
  });

  it('getAllCustomThemes - empty initially', async () => {
    const themes = await repo.getAllCustomThemes();
    expect(themes).toHaveLength(0);
  });

  it('createCustomTheme - creates and returns theme', async () => {
    // No userId passed — avoids FK constraint on users.id in test DB
    const theme = await repo.createCustomTheme('Dark Mode', 'custom-dark', '{"color":"#000"}');
    expect(theme.name).toBe('Dark Mode');
    expect(theme.slug).toBe('custom-dark');
    expect(theme.is_builtin).toBe(0);
    expect(theme.id).toBeGreaterThan(0);
  });

  it('getAllCustomThemes - returns created themes', async () => {
    await repo.createCustomTheme('Theme A', 'custom-a', '{}', undefined);
    await repo.createCustomTheme('Theme B', 'custom-b', '{}', undefined);
    const themes = await repo.getAllCustomThemes();
    expect(themes).toHaveLength(2);
    // ordered by name asc
    expect(themes[0].slug).toBe('custom-a');
    expect(themes[1].slug).toBe('custom-b');
  });

  it('getCustomThemeBySlug - returns correct theme', async () => {
    await repo.createCustomTheme('My Theme', 'custom-my', '{"color":"#fff"}', undefined);
    const theme = await repo.getCustomThemeBySlug('custom-my');
    expect(theme).toBeDefined();
    expect(theme!.name).toBe('My Theme');
  });

  it('getCustomThemeBySlug - returns undefined for missing slug', async () => {
    const theme = await repo.getCustomThemeBySlug('custom-nonexistent');
    expect(theme).toBeUndefined();
  });

  it('updateCustomTheme - updates name and definition', async () => {
    await repo.createCustomTheme('Old Name', 'custom-upd', '{}', undefined);
    const result = await repo.updateCustomTheme('custom-upd', { name: 'New Name', definition: '{"x":1}' });
    expect(result).toBe(true);
    const updated = await repo.getCustomThemeBySlug('custom-upd');
    expect(updated!.name).toBe('New Name');
  });

  it('updateCustomTheme - returns false for nonexistent slug', async () => {
    const result = await repo.updateCustomTheme('custom-missing', { name: 'X' });
    expect(result).toBe(false);
  });

  it('deleteCustomTheme - deletes a theme', async () => {
    await repo.createCustomTheme('Delete Me', 'custom-del', '{}', undefined);
    const result = await repo.deleteCustomTheme('custom-del');
    expect(result).toBe(true);
    expect(await repo.getCustomThemeBySlug('custom-del')).toBeUndefined();
  });

  it('deleteCustomTheme - returns false for nonexistent slug', async () => {
    const result = await repo.deleteCustomTheme('custom-nope');
    expect(result).toBe(false);
  });
});
