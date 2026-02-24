import express from 'express';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * Validates a GitHub path to prevent SSRF and path traversal attacks
 * Duplicated from docs/.vitepress/utils/githubUrlValidation.ts for server-side use
 */
function validateGitHubPath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    return false;
  }

  // Maximum path length to prevent DoS
  const MAX_PATH_LENGTH = 200;
  if (path.length > MAX_PATH_LENGTH) {
    return false;
  }

  // Prevent path traversal attempts
  if (path.includes('../') || path.includes('..\\') || path.includes('/..') || path.includes('\\..')) {
    return false;
  }

  // Split path into segments
  const segments = path.split('/').filter(Boolean);
  
  if (segments.length === 0) {
    return false;
  }

  // Check each segment for path traversal
  for (const segment of segments) {
    // Reject segments that are exactly '..'
    if (segment === '..' || segment === '.') {
      return false;
    }
  }

  // If path starts with "examples/", validate it's a safe path
  if (path.startsWith('examples/')) {
    const filePath = path.substring('examples/'.length);
    return validateFilePath(filePath);
  }

  // For external repos: "USERNAME/repo/path" or "USERNAME/repo/branch/path"
  if (segments.length >= 3) {
    const username = segments[0];
    const repo = segments[1];
    
    // Validate username (GitHub username rules: alphanumeric, hyphens, max 39 chars)
    if (!validateGitHubIdentifier(username, 39)) {
      return false;
    }
    
    // Validate repo name (same rules as username)
    if (!validateGitHubIdentifier(repo, 100)) {
      return false;
    }

    // Check if 3rd segment is a branch name
    const commonBranches = ['main', 'master', 'develop', 'dev'];
    const possibleBranch = segments[2];
    
    if (commonBranches.includes(possibleBranch.toLowerCase()) && segments.length >= 4) {
      // Format: USERNAME/repo/branch/path/to/file
      const filePath = segments.slice(3).join('/');
      return validateFilePath(filePath);
    } else {
      // Format: USERNAME/repo/path/to/file (defaults to main branch)
      const filePath = segments.slice(2).join('/');
      return validateFilePath(filePath);
    }
  }

  // Fallback: treat as file path relative to main repo
  return validateFilePath(path);
}

function validateGitHubIdentifier(identifier: string, maxLength: number): boolean {
  if (!identifier || identifier.length === 0 || identifier.length > maxLength) {
    return false;
  }

  // GitHub identifiers: alphanumeric, hyphens, underscores
  // Cannot start or end with hyphen
  const identifierPattern = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;
  
  return identifierPattern.test(identifier);
}

function validateFilePath(filePath: string): boolean {
  if (!filePath || filePath.length === 0) {
    return false;
  }

  // Prevent path traversal
  if (filePath.includes('../') || filePath.includes('..\\') || filePath.includes('/..') || filePath.includes('\\..')) {
    return false;
  }

  // Split into segments and validate each
  const segments = filePath.split('/').filter(Boolean);
  
  for (const segment of segments) {
    // Reject path traversal segments
    if (segment === '..' || segment === '.') {
      return false;
    }

    // Allow alphanumeric, hyphens, underscores, dots (for file extensions)
    // But prevent other special characters that could be dangerous
    const validSegmentPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validSegmentPattern.test(segment)) {
      return false;
    }
  }

  return true;
}

/**
 * Proxies GitHub raw content requests to avoid CORS issues
 * Applies security validations: URL validation, timeout, content-type, size limits
 */
router.get('/script-content', optionalAuth(), async (req, res) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Security: Validate URL format
    let validatedUrl: URL;
    try {
      validatedUrl = new URL(url);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Security: Only allow raw.githubusercontent.com
    if (validatedUrl.hostname !== 'raw.githubusercontent.com') {
      return res.status(400).json({ error: 'Only raw.githubusercontent.com URLs are allowed' });
    }

    // Security: Only allow HTTPS
    if (validatedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
    }

    // Security: Extract path and validate GitHub path format
    const path = validatedUrl.pathname.substring(1); // Remove leading /
    if (!validateGitHubPath(path)) {
      logger.warn(`Invalid GitHub path detected: ${path}`);
      return res.status(400).json({ error: 'Invalid GitHub path format' });
    }

    logger.debug(`📜 Fetching script content from: ${url}`);

    // Security: Maximum file size (500KB)
    const MAX_FILE_SIZE = 500 * 1024;

    // Security: Add timeout using AbortController (10 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'MeshMonitor-ScriptContent/1.0',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(`Failed to fetch script content: ${response.status} ${response.statusText}`);
        return res.status(response.status).json({ error: `Failed to fetch script content: ${response.statusText}` });
      }

      // Security: Validate Content-Type header
      const contentType = response.headers.get('content-type') || '';
      
      // Reject HTML responses (could be error pages or malicious content)
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        logger.warn(`Rejected HTML content type: ${contentType}`);
        return res.status(400).json({ error: 'HTML content not allowed. Expected script file content.' });
      }
      
      if (!contentType.includes('text/') && !contentType.includes('application/')) {
        logger.warn(`Invalid content type: ${contentType}`);
        return res.status(400).json({ error: `Invalid content type: ${contentType}. Expected text/* or application/*` });
      }

      // Security: Check Content-Length header for size limit
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        logger.warn(`File too large: ${contentLength} bytes`);
        return res.status(400).json({ error: `File too large: ${contentLength} bytes. Maximum size is ${MAX_FILE_SIZE} bytes (500KB)` });
      }

      // Read response body
      const text = await response.text();

      // Security: Detect HTML content even if Content-Type is wrong
      const trimmedText = text.trim();
      if (trimmedText.startsWith('<!DOCTYPE') || trimmedText.startsWith('<html') || trimmedText.startsWith('<?xml')) {
        logger.warn('Rejected HTML content detected in response body');
        return res.status(400).json({ error: 'HTML content detected. Expected script file content. The file may not exist or the URL may be incorrect.' });
      }

      // Security: Double-check size after reading (in case Content-Length was missing)
      if (text.length > MAX_FILE_SIZE) {
        logger.warn(`File too large after reading: ${text.length} bytes`);
        return res.status(400).json({ error: `File too large: ${text.length} bytes. Maximum size is ${MAX_FILE_SIZE} bytes (500KB)` });
      }

      // Return content with appropriate content-type
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);

    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        logger.warn(`Script content fetch timeout for: ${url}`);
        return res.status(504).json({ error: 'Request timeout after 10 seconds' });
      }

      logger.error('Error fetching script content:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch script content' });
    }

  } catch (error) {
    logger.error('Error in script content endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

