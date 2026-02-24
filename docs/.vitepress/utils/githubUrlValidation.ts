/**
 * GitHub URL validation utilities for preventing SSRF attacks
 * Validates GitHub paths to ensure they are safe before constructing URLs
 */

/**
 * Validates a GitHub path to prevent SSRF and path traversal attacks
 * 
 * @param path - GitHub path in format "examples/path" or "USERNAME/repo/path" or "USERNAME/repo/branch/path"
 * @returns true if path is valid, false otherwise
 */
export function validateGitHubPath(path: string): boolean {
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

/**
 * Validates a GitHub username or repository name
 * GitHub allows: alphanumeric, hyphens, underscores
 * 
 * @param identifier - Username or repo name
 * @param maxLength - Maximum allowed length
 * @returns true if valid, false otherwise
 */
function validateGitHubIdentifier(identifier: string, maxLength: number): boolean {
  if (!identifier || identifier.length === 0 || identifier.length > maxLength) {
    return false;
  }

  // GitHub identifiers: alphanumeric, hyphens, underscores
  // Cannot start or end with hyphen
  const identifierPattern = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;
  
  return identifierPattern.test(identifier);
}

/**
 * Validates a file path segment
 * Allows alphanumeric, hyphens, underscores, dots, and slashes
 * Prevents path traversal and dangerous characters
 * 
 * @param filePath - File path to validate
 * @returns true if valid, false otherwise
 */
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

