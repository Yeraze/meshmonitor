import { Router, Request, Response } from 'express';
import { requirePermission, optionalAuth } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.get('/', optionalAuth(), async (_req: Request, res: Response) => {
  try {
    const themes = await databaseService.misc.getAllCustomThemes();
    res.json({ themes });
  } catch (error) {
    logger.error('Error fetching custom themes:', error);
    res.status(500).json({ error: 'Failed to fetch custom themes' });
  }
});

router.get('/:slug', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const theme = await databaseService.misc.getCustomThemeBySlug(slug);

    if (!theme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    res.json({ theme });
  } catch (error) {
    logger.error(`Error fetching theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to fetch theme' });
  }
});

router.post('/', requirePermission('themes', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, slug, definition } = req.body;

    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
      return res.status(400).json({ error: 'Theme name must be 1-50 characters' });
    }

    if (!slug || typeof slug !== 'string' || !slug.match(/^custom-[a-z0-9-]+$/)) {
      return res
        .status(400)
        .json({ error: 'Slug must start with "custom-" and contain only lowercase letters, numbers, and hyphens' });
    }

    const existingTheme = await databaseService.misc.getCustomThemeBySlug(slug);
    if (existingTheme) {
      return res.status(409).json({ error: 'Theme with this slug already exists' });
    }

    if (!databaseService.validateThemeDefinition(definition)) {
      return res
        .status(400)
        .json({ error: 'Invalid theme definition. All required color variables must be valid hex codes' });
    }

    const theme = await databaseService.misc.createCustomTheme(name, slug, JSON.stringify(definition), req.user!.id);

    databaseService.auditLogAsync(
      req.user!.id,
      'theme_created',
      'themes',
      `Created custom theme: ${name} (${slug})`,
      req.ip || null,
      null,
      JSON.stringify({ id: theme.id, name, slug })
    );

    res.status(201).json({ success: true, theme });
  } catch (error) {
    logger.error('Error creating custom theme:', error);
    res.status(500).json({ error: 'Failed to create custom theme' });
  }
});

router.put('/:slug', requirePermission('themes', 'write'), async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const { name, definition } = req.body;

    const existingTheme = await databaseService.misc.getCustomThemeBySlug(slug);
    if (!existingTheme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    if (existingTheme.is_builtin) {
      return res.status(403).json({ error: 'Cannot modify built-in themes' });
    }

    const updates: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.length < 1 || name.length > 50) {
        return res.status(400).json({ error: 'Theme name must be 1-50 characters' });
      }
      updates.name = name;
    }

    if (definition !== undefined) {
      if (!databaseService.validateThemeDefinition(definition)) {
        return res
          .status(400)
          .json({ error: 'Invalid theme definition. All required color variables must be valid hex codes' });
      }
      updates.definition = definition;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const repoUpdates: Record<string, string> = {};
    if (updates.name) repoUpdates.name = updates.name as string;
    if (updates.definition) repoUpdates.definition = JSON.stringify(updates.definition);
    await databaseService.misc.updateCustomTheme(slug, repoUpdates);

    databaseService.auditLogAsync(
      req.user!.id,
      'theme_updated',
      'themes',
      `Updated custom theme: ${existingTheme.name} (${slug})`,
      req.ip || null,
      JSON.stringify({ name: existingTheme.name }),
      JSON.stringify(updates)
    );

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error updating theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

router.delete('/:slug', requirePermission('themes', 'write'), async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;

    const theme = await databaseService.misc.getCustomThemeBySlug(slug);
    if (!theme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    if (theme.is_builtin) {
      return res.status(403).json({ error: 'Cannot delete built-in themes' });
    }

    await databaseService.misc.deleteCustomTheme(slug);

    databaseService.auditLogAsync(
      req.user!.id,
      'theme_deleted',
      'themes',
      `Deleted custom theme: ${theme.name} (${slug})`,
      req.ip || null,
      JSON.stringify({ id: theme.id, name: theme.name, slug }),
      null
    );

    res.json({ success: true, message: 'Theme deleted successfully' });
  } catch (error) {
    logger.error(`Error deleting theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to delete theme' });
  }
});

export default router;
