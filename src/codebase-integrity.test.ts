import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

describe('Codebase Integrity', () => {
  describe('No hardcoded node identifiers', () => {
    const KNOWN_NODE_IDS = [
      '!a2e4ff4c',  // Yeraze StationG2
      '2732916556', // Yeraze StationG2 nodeNum
    ];

    const KNOWN_NODE_NAMES = [
      'Yeraze StationG2',
      'Yeraze Station',
    ];

    // Files to check (non-test files)
    const getAllSourceFiles = (dir: string, fileList: string[] = []): string[] => {
      const files = readdirSync(dir);

      files.forEach((file) => {
        const filePath = join(dir, file);
        const stat = statSync(filePath);

        if (stat.isDirectory()) {
          // Skip node_modules, dist, and hidden directories
          if (!file.startsWith('.') && file !== 'node_modules' && file !== 'dist') {
            getAllSourceFiles(filePath, fileList);
          }
        } else if (
          // Include TypeScript/JavaScript files
          (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) &&
          // Exclude test files
          !file.endsWith('.test.ts') &&
          !file.endsWith('.test.tsx') &&
          !file.endsWith('.test.js') &&
          !file.endsWith('.test.jsx')
        ) {
          fileList.push(filePath);
        }
      });

      return fileList;
    };

    it('should not contain hardcoded node IDs in source files', () => {
      const srcDir = join(__dirname);
      const sourceFiles = getAllSourceFiles(srcDir);

      const violations: { file: string; nodeId: string; line: number }[] = [];

      sourceFiles.forEach((file) => {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          // Skip comments
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
            return;
          }

          KNOWN_NODE_IDS.forEach((nodeId) => {
            if (line.includes(nodeId)) {
              violations.push({
                file: file.replace(srcDir, 'src'),
                nodeId,
                line: index + 1,
              });
            }
          });
        });
      });

      if (violations.length > 0) {
        const message = violations
          .map((v) => `  ${v.file}:${v.line} contains hardcoded node ID: ${v.nodeId}`)
          .join('\n');

        throw new Error(
          `Found hardcoded node IDs in source files:\n${message}\n\n` +
          'Node IDs should be retrieved from settings or API responses, not hardcoded.'
        );
      }

      expect(violations).toHaveLength(0);
    });

    it('should not contain hardcoded node names in source files', () => {
      const srcDir = join(__dirname);
      const sourceFiles = getAllSourceFiles(srcDir);

      const violations: { file: string; nodeName: string; line: number }[] = [];

      sourceFiles.forEach((file) => {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          // Skip comments
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
            return;
          }

          KNOWN_NODE_NAMES.forEach((nodeName) => {
            // Case-insensitive check
            if (line.toLowerCase().includes(nodeName.toLowerCase())) {
              violations.push({
                file: file.replace(srcDir, 'src'),
                nodeName,
                line: index + 1,
              });
            }
          });
        });
      });

      if (violations.length > 0) {
        const message = violations
          .map((v) => `  ${v.file}:${v.line} contains hardcoded node name: ${v.nodeName}`)
          .join('\n');

        throw new Error(
          `Found hardcoded node names in source files:\n${message}\n\n` +
          'Node names should be retrieved from settings or API responses, not hardcoded.'
        );
      }

      expect(violations).toHaveLength(0);
    });

    it('should allow node identifiers in test files', () => {
      // This test just documents that test files CAN contain these identifiers
      // Test files are excluded from the checks above

      const testFile = readFileSync(__filename, 'utf8');

      // Verify our test file contains the identifiers (meta test)
      expect(testFile).toContain('!a2e4ff4c');
      expect(testFile).toContain('2732916556');
      expect(testFile).toContain('Yeraze StationG2');
    });
  });

  describe('No hardcoded API credentials', () => {
    const getAllSourceFiles = (dir: string, fileList: string[] = []): string[] => {
      const files = readdirSync(dir);

      files.forEach((file) => {
        const filePath = join(dir, file);
        const stat = statSync(filePath);

        if (stat.isDirectory()) {
          if (!file.startsWith('.') && file !== 'node_modules' && file !== 'dist') {
            getAllSourceFiles(filePath, fileList);
          }
        } else if (
          (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) &&
          !file.endsWith('.test.ts') &&
          !file.endsWith('.test.tsx')
        ) {
          fileList.push(filePath);
        }
      });

      return fileList;
    };

    it('should not contain hardcoded API keys or secrets', () => {
      const srcDir = join(__dirname);
      const sourceFiles = getAllSourceFiles(srcDir);

      const suspiciousPatterns = [
        /api[_-]?key\s*=\s*['"][^'"]{20,}['"]/i,
        /secret\s*=\s*['"][^'"]{20,}['"]/i,
        /password\s*=\s*['"][^'"]+['"]/i,
        /token\s*=\s*['"][^'"]{20,}['"]/i,
      ];

      const violations: { file: string; pattern: string; line: number }[] = [];

      sourceFiles.forEach((file) => {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          // Skip comments
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
            return;
          }

          // Skip default admin password in database service (intentional for first-run setup)
          if (file.includes('database.ts') && line.includes("password = 'changeme'")) {
            return;
          }

          suspiciousPatterns.forEach((pattern) => {
            if (pattern.test(line)) {
              violations.push({
                file: file.replace(srcDir, 'src'),
                pattern: pattern.source,
                line: index + 1,
              });
            }
          });
        });
      });

      if (violations.length > 0) {
        const message = violations
          .map((v) => `  ${v.file}:${v.line} contains potential hardcoded credential`)
          .join('\n');

        throw new Error(
          `Found potential hardcoded credentials in source files:\n${message}\n\n` +
          'Credentials should be in environment variables or configuration files, not hardcoded.'
        );
      }

      expect(violations).toHaveLength(0);
    });
  });
});
