/**
 * Pins the exact contents of SOURCEY_RESOURCES (src/types/permission.ts) and
 * guards against a second, competing definition ever being reintroduced.
 *
 * Background (issue #4416, PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md): two
 * SOURCEY_RESOURCES lists existed — this one (typed `ResourceType[]`, used by
 * the frontend and by `checkPermissionAsync`) and a second, untyped
 * `Set<string>` at `src/server/constants/permissions.ts` that nothing ever
 * imported. The two disagreed on whether `settings` was sourcey, and the
 * untyped duplicate made the drift invisible to the compiler. This phase
 * deletes the duplicate and adds `settings` to the surviving, canonical list
 * (spec §2.1). This file is the guard that stops a second list from quietly
 * reappearing (spec §2.2).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { SOURCEY_RESOURCES, isSourceyResource, type ResourceType } from './permission';

describe('SOURCEY_RESOURCES canonical list (#4416)', () => {
  // Pinned exact contents per PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §2.1.
  // Named EXPECTED_* (not SOURCEY_RESOURCES) so this test file itself does not
  // trip the drift guard below.
  const EXPECTED_SOURCEY_RESOURCES: ResourceType[] = [
    'channel_0', 'channel_1', 'channel_2', 'channel_3',
    'channel_4', 'channel_5', 'channel_6', 'channel_7',
    'messages', 'nodes', 'nodes_private', 'traceroute',
    'packetmonitor', 'configuration', 'connection', 'automation',
    'waypoints', 'remote_admin', 'settings',
  ];

  it('matches the exact, spec-approved contents — not a subset check (PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §2.1)', () => {
    const actual = [...SOURCEY_RESOURCES].sort();
    const expected = [...EXPECTED_SOURCEY_RESOURCES].sort();

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        'SOURCEY_RESOURCES in src/types/permission.ts has drifted from the list ' +
        'pinned by docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §2.1.\n' +
        `  actual:   ${JSON.stringify(actual)}\n` +
        `  expected: ${JSON.stringify(expected)}\n` +
        'If this addition/removal is intentional, it requires a fan-out migration ' +
        '(see spec §3, migration 132) before this pin is updated to match.'
      );
    }

    expect(actual).toEqual(expected);
  });

  it("classifies 'settings' as sourcey — added by #4416 (spec §2.1)", () => {
    expect(isSourceyResource('settings')).toBe(true);
  });

  // dashboard/info/audit/security are deliberately NOT sourcey — spec §1.3.
  // Each assertion below is a recorded decision, not an omission.
  it("does not classify 'dashboard' as sourcey — deliberate: cross-source nav gate (spec §1.3)", () => {
    expect(isSourceyResource('dashboard')).toBe(false);
  });

  it("does not classify 'info' as sourcey — deliberate: cross-source nav gate (spec §1.3)", () => {
    expect(isSourceyResource('info')).toBe(false);
  });

  it("does not classify 'audit' as sourcey — deliberate: audit_log has no sourceId column (spec §1.3)", () => {
    expect(isSourceyResource('audit')).toBe(false);
  });

  it("does not classify 'security' as sourcey — deliberate: install-wide, no sourceId column (spec §1.3)", () => {
    expect(isSourceyResource('security')).toBe(false);
  });

  describe('drift guard — no second SOURCEY_RESOURCES declaration exists (spec §2.2)', () => {
    // Root of the scan is src/ (this file lives at src/types/, so ../ is src/).
    const SRC_ROOT = join(__dirname, '..');

    // A "declaration" is `const SOURCEY_RESOURCES` (with or without `export`),
    // as opposed to an import (`import { SOURCEY_RESOURCES } from ...`) or a
    // mere usage (`SOURCEY_RESOURCES.includes(...)`) or a comment mentioning it.
    //
    // Built via concatenation, not a literal regex, so that THIS line does not
    // itself contain the contiguous text "const SOURCEY_RESOURCES" and trip
    // its own pattern when this file is scanned.
    const DECLARATION_KEYWORD = ['SOURCEY', 'RESOURCES'].join('_');
    const DECLARATION_PATTERN = new RegExp(`(?:export\\s+)?const\\s+${DECLARATION_KEYWORD}\\b`);

    // Permitted per spec §2.2:
    //  - src/types/permission.ts — the canonical definition.
    //  - src/server/migrations/** — migrations legitimately freeze their own
    //    point-in-time copy (033 does; 132 will). Frozen snapshots, not a
    //    competing source of truth.
    const isPermittedPath = (relPath: string): boolean => {
      const normalized = relPath.split(sep).join('/');
      return (
        normalized === 'types/permission.ts' ||
        normalized.startsWith('server/migrations/')
      );
    };

    const getAllSourceFiles = (dir: string, fileList: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        // Skip hidden dirs (incl. any stray .claude/worktrees), node_modules, dist.
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
          continue;
        }
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          getAllSourceFiles(fullPath, fileList);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          fileList.push(fullPath);
        }
      }
      return fileList;
    };

    it('finds SOURCEY_RESOURCES declarations only in permitted locations', () => {
      const files = getAllSourceFiles(SRC_ROOT);
      const violations: { file: string; line: number }[] = [];

      for (const file of files) {
        const relPath = relative(SRC_ROOT, file);
        if (isPermittedPath(relPath)) continue;

        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          // Skip comment lines (precedent: src/codebase-integrity.test.ts) —
          // this also keeps this guard's own doc-comments, which discuss the
          // pattern in prose, from tripping over themselves.
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

          if (DECLARATION_PATTERN.test(line)) {
            violations.push({ file: relPath.split(sep).join('/'), line: idx + 1 });
          }
        });
      }

      if (violations.length > 0) {
        const message = violations.map((v) => `  src/${v.file}:${v.line}`).join('\n');
        throw new Error(
          'Found a SOURCEY_RESOURCES declaration outside the permitted locations ' +
          '(src/types/permission.ts and src/server/migrations/**):\n' +
          `${message}\n\n` +
          'Per docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §2.2, ' +
          'there must be exactly one canonical SOURCEY_RESOURCES definition. A second, ' +
          'competing list is the exact defect that caused issue #4416 — reconcile it ' +
          'into src/types/permission.ts instead of declaring a new one.'
        );
      }

      expect(violations).toHaveLength(0);
    });
  });
});
