/**
 * Deployment-method detection.
 *
 * Extracted from the retired upgradeService (Auto-Upgrade Retirement, 4.13).
 * The result is used by the version-check endpoint to show deployment-specific
 * update instructions in the UI (docker / lxc / kubernetes / manual).
 *
 * The detection is stable for the lifetime of the process, so the result is
 * cached at module level after the first call.
 */
import * as fs from 'fs';

export type DeploymentMethod = 'docker' | 'lxc' | 'kubernetes' | 'manual';

let cached: DeploymentMethod | null = null;

/**
 * Detect how MeshMonitor is deployed.
 *
 * - Kubernetes: `KUBERNETES_SERVICE_HOST` env var is injected into every pod.
 * - Docker: `/.dockerenv` exists.
 * - LXC: `/proc/1/environ` contains `container=lxc`.
 * - Otherwise: manual (bare metal / desktop / etc.).
 *
 * Cached after first invocation.
 */
export function detectDeploymentMethod(): DeploymentMethod {
  if (cached) return cached;

  let method: DeploymentMethod = 'manual';

  if (process.env.KUBERNETES_SERVICE_HOST) {
    method = 'kubernetes';
  } else if (fs.existsSync('/.dockerenv')) {
    method = 'docker';
  } else {
    // LXC containers expose container=lxc in PID 1's environment.
    try {
      if (fs.existsSync('/proc/1/environ')) {
        const environ = fs.readFileSync('/proc/1/environ', 'utf8');
        if (environ.includes('container=lxc')) {
          method = 'lxc';
        }
      }
    } catch {
      // Ignore errors reading /proc/1/environ — fall through to 'manual'.
    }
  }

  cached = method;
  return method;
}

/**
 * Reset the module-level cache. Test-only.
 */
export function __resetDeploymentCacheForTests(): void {
  cached = null;
}
