# Phase 7 — Per-Source Virtual Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Virtual Node a per-source feature owned by `MeshtasticManager`, configurable through the add/edit source UI, and remove the legacy `global.virtualNodeServer` singleton and its env-var config.

**Architecture:** Each `meshtastic_tcp` source stores optional `virtualNode: { enabled, port, allowAdminCommands }` inside its `sources.config` JSON. `MeshtasticManager` owns the `VirtualNodeServer` instance, wires it to its own packet path, and exposes `reconfigureVirtualNode()` so `SourceManagerRegistry.updateSource()` can hot-swap the sub-feature without restarting the source. Source CRUD routes validate port uniqueness across sources. The Dashboard source modal gains a Virtual Node form section.

**Tech Stack:** TypeScript, Node.js, React (functional components), Vitest, Drizzle ORM, Express.

**Spec:** `docs/superpowers/specs/2026-04-08-phase7-virtual-node-per-source-design.md`

---

## File Structure

**Modify:**
- `src/server/meshtasticManager.ts` — own `virtualNodeServer`, wire start/stop, broadcast from instance, add `reconfigureVirtualNode`
- `src/server/sourceManagerRegistry.ts` — detect VN-config changes in `updateSource` and hot-swap
- `src/server/routes/sourceRoutes.ts` — validate VN config (type gate, port range, self-port collision, cross-source collision)
- `src/server/routes/sourceRoutes.test.ts` — new validation tests
- `src/server/server.ts` — delete global VN startup block, remove `VirtualNodeServer` import, remove broadcast sites that use `global.virtualNodeServer`
- `src/server/config/environment.ts` — remove `virtualNodeEnabled`, `virtualNodePort`, `virtualNodeAllowAdminCommands`
- `src/pages/DashboardPage.tsx` — add Virtual Node form fields and badge
- `tests/test-virtual-node.sh` — rewrite to use per-source API
- `CHANGELOG.md` or release notes — document breaking change

**Create:**
- `src/server/meshtasticManager.virtualNode.test.ts` — unit tests for VN wiring
- `src/server/sourceManagerRegistry.virtualNode.test.ts` — unit tests for hot-swap

**No migrations.** `virtualNode` lives inside the existing `sources.config` JSON blob.

---

### Task 1: Shared `VirtualNodeConfig` type

**Files:**
- Modify: `src/server/virtualNodeServer.ts`

- [ ] **Step 1: Add exported config interface at top of file**

```ts
/**
 * Per-source virtual node configuration.
 * Stored inside sources.config.virtualNode for meshtastic_tcp sources.
 */
export interface VirtualNodeConfig {
  enabled: boolean;
  port: number;
  allowAdminCommands: boolean;
}
```

- [ ] **Step 2: Verify the file still type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/virtualNodeServer.ts
git commit -m "refactor(virtual-node): export VirtualNodeConfig type"
```

---

### Task 2: `MeshtasticManager` owns `VirtualNodeServer`

**Files:**
- Modify: `src/server/meshtasticManager.ts`
- Create: `src/server/meshtasticManager.virtualNode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/meshtasticManager.virtualNode.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';

// Mock the VirtualNodeServer so tests never bind a real TCP port
const startMock = vi.fn().mockResolvedValue(undefined);
const stopMock = vi.fn().mockResolvedValue(undefined);
const broadcastMock = vi.fn().mockResolvedValue(undefined);
const VNConstructor = vi.fn().mockImplementation(() => ({
  start: startMock,
  stop: stopMock,
  broadcastToClients: broadcastMock,
  isRunning: () => true,
  getClientCount: () => 0,
}));
vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: VNConstructor,
}));

// Stub the TCP transport so start()/stop() don't try to connect
vi.mock('./transports/tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
  },
}));

describe('MeshtasticManager — Virtual Node wiring', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
    startMock.mockClear();
    stopMock.mockClear();
  });

  it('does not create a VirtualNodeServer when virtualNode is absent', () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    expect(VNConstructor).not.toHaveBeenCalled();
    expect((mgr as any).virtualNodeServer).toBeUndefined();
  });

  it('creates a VirtualNodeServer when virtualNode.enabled is true', () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    expect(VNConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4503, allowAdminCommands: false })
    );
    expect((mgr as any).virtualNodeServer).toBeDefined();
  });

  it('does not create a VirtualNodeServer when virtualNode.enabled is false', () => {
    new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: false, port: 4503, allowAdminCommands: false },
    });
    expect(VNConstructor).not.toHaveBeenCalled();
  });

  it('reconfigureVirtualNode(config) stops the old server and starts a new one', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    VNConstructor.mockClear();
    stopMock.mockClear();

    await mgr.reconfigureVirtualNode({ enabled: true, port: 4504, allowAdminCommands: true });

    expect(stopMock).toHaveBeenCalled();
    expect(VNConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4504, allowAdminCommands: true })
    );
  });

  it('reconfigureVirtualNode(undefined) stops and clears the server', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    stopMock.mockClear();

    await mgr.reconfigureVirtualNode(undefined);

    expect(stopMock).toHaveBeenCalled();
    expect((mgr as any).virtualNodeServer).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run src/server/meshtasticManager.virtualNode.test.ts`
Expected: FAIL — `reconfigureVirtualNode` does not exist; constructor does not accept `virtualNode`.

- [ ] **Step 3: Extend `MeshtasticManager` constructor config type**

In `src/server/meshtasticManager.ts`, locate the `TransportConfig` / source-config interface the constructor takes. Add the optional field:

```ts
import { VirtualNodeServer, VirtualNodeConfig } from './virtualNodeServer.js';

// (inside the config interface that the constructor accepts)
virtualNode?: VirtualNodeConfig;
```

- [ ] **Step 4: Store `virtualNodeServer` instance on the class**

Add a private field and initialize it in the constructor:

```ts
private virtualNodeServer?: VirtualNodeServer;

constructor(sourceId: string, config: MeshtasticManagerConfig /* existing type */) {
  // ...existing initialization...
  this.sourceId = sourceId;
  this.config = config;

  if (config.virtualNode?.enabled) {
    this.virtualNodeServer = new VirtualNodeServer({
      port: config.virtualNode.port,
      allowAdminCommands: config.virtualNode.allowAdminCommands,
    });
  }
}
```

- [ ] **Step 5: Wire start/stop**

Locate the `start()` method and, after the transport reports connected, call:

```ts
if (this.virtualNodeServer) {
  await this.virtualNodeServer.start();
  logger.info(`🌐 Virtual node for source ${this.sourceId} started on port ${this.config.virtualNode?.port}`);
}
```

Locate `stop()` and, before transport disconnect, call:

```ts
if (this.virtualNodeServer) {
  try {
    await this.virtualNodeServer.stop();
  } catch (err) {
    logger.error(`Failed to stop virtual node for source ${this.sourceId}:`, err);
  }
}
```

- [ ] **Step 6: Add `reconfigureVirtualNode` method**

Add a public method on the class:

```ts
/**
 * Hot-swap the virtual node sub-feature without restarting the source.
 * Stops any running VN server, then starts a new one if the new config has enabled=true.
 */
public async reconfigureVirtualNode(config: VirtualNodeConfig | undefined): Promise<void> {
  if (this.virtualNodeServer) {
    try {
      await this.virtualNodeServer.stop();
    } catch (err) {
      logger.error(`Failed to stop virtual node during reconfigure for source ${this.sourceId}:`, err);
    }
    this.virtualNodeServer = undefined;
  }

  if (config?.enabled) {
    this.virtualNodeServer = new VirtualNodeServer({
      port: config.port,
      allowAdminCommands: config.allowAdminCommands,
    });
    await this.virtualNodeServer.start();
    logger.info(`🌐 Virtual node for source ${this.sourceId} reconfigured on port ${config.port}`);
  }

  // Persist the updated config on the instance so later lifecycle events read the new values
  if (this.config) {
    this.config.virtualNode = config;
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/server/meshtasticManager.virtualNode.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add src/server/meshtasticManager.ts src/server/meshtasticManager.virtualNode.test.ts
git commit -m "feat(virtual-node): MeshtasticManager owns per-source VirtualNodeServer"
```

---

### Task 3: Move broadcast call sites from global to instance

**Files:**
- Modify: `src/server/meshtasticManager.ts`
- Modify: `src/server/server.ts`

- [ ] **Step 1: Identify the broadcast sites in server.ts**

Run: `grep -n "global as any).virtualNodeServer\|virtualNodeServer.broadcastToClients" src/server/server.ts`

Expected: two broadcast sites (approximately lines 1208–1253 and 1484–1529) and several reads of `global.virtualNodeServer` for status endpoints.

- [ ] **Step 2: In `meshtasticManager.ts`, locate the equivalent packet handlers**

The packet handlers in `MeshtasticManager` are the per-source equivalents of the `server.ts` broadcast sites. Find the handler that emits NodeInfo / position / text events (search for `nodeInfoMessage` or the protobuf type being assembled).

- [ ] **Step 3: Add instance-level broadcasts**

At each of the identified handlers in `meshtasticManager.ts`, after the event is processed, add:

```ts
if (this.virtualNodeServer) {
  try {
    await this.virtualNodeServer.broadcastToClients(meshPacket);
  } catch (err) {
    logger.error(`Virtual node broadcast failed for source ${this.sourceId}:`, err);
  }
}
```

Use the same `meshPacket` / `nodeInfoMessage` variable name that was being passed to the global broadcast in `server.ts`. If the shape differs between the two files, pass the equivalent raw `MeshPacket` rebuilt from the data already in scope (the same shape the legacy call built).

- [ ] **Step 4: Delete the global broadcast sites in server.ts**

In `src/server/server.ts`, delete the two blocks that read `(global as any).virtualNodeServer` and call `broadcastToClients`. Keep the admin-status endpoint blocks (~line 2416) for now — Task 4 rewrites them.

- [ ] **Step 5: Run full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all existing tests pass; the meshtasticManager tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/meshtasticManager.ts src/server/server.ts
git commit -m "refactor(virtual-node): move broadcast from global singleton to manager instance"
```

---

### Task 4: Delete `global.virtualNodeServer` and legacy env-var startup

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/config/environment.ts`

- [ ] **Step 1: Remove env-var fields from environment.ts**

In `src/server/config/environment.ts`, delete the `virtualNodeEnabled`, `virtualNodePort`, and `virtualNodeAllowAdminCommands` fields and any parsing of `ENABLE_VIRTUAL_NODE`, `VIRTUAL_NODE_PORT`, `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS`.

- [ ] **Step 2: Remove global startup block in server.ts**

In `src/server/server.ts`, delete the block around line 337 that constructs `new VirtualNodeServer(...)`, calls `.start()`, and assigns to `(global as any).virtualNodeServer`. Also delete the outer `if (env.virtualNodeEnabled)` guard.

- [ ] **Step 3: Rewrite the VN admin-status endpoint**

Locate the route handler around line 2416 that reads `(global as any).virtualNodeServer` to report status. Replace its body with:

```ts
// Report status across all sources that have a virtual node running
const statuses = sourceManagerRegistry.getAllManagers().map((mgr) => ({
  sourceId: mgr.sourceId,
  sourceName: mgr.sourceName ?? mgr.sourceId,
  virtualNode: mgr.getVirtualNodeStatus(),
}));
res.json({ sources: statuses });
```

- [ ] **Step 4: Add `getVirtualNodeStatus()` to `MeshtasticManager`**

In `src/server/meshtasticManager.ts`:

```ts
public getVirtualNodeStatus(): { enabled: boolean; port: number | null; clientCount: number } {
  if (!this.virtualNodeServer) {
    return { enabled: false, port: null, clientCount: 0 };
  }
  return {
    enabled: this.virtualNodeServer.isRunning(),
    port: this.config.virtualNode?.port ?? null,
    clientCount: this.virtualNodeServer.getClientCount(),
  };
}
```

- [ ] **Step 5: Remove `VirtualNodeServer` import from server.ts**

Delete the `import { VirtualNodeServer } from './virtualNodeServer.js';` line at the top of `src/server/server.ts`.

- [ ] **Step 6: Run the type check and full test suite**

Run: `npx tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.ts src/server/config/environment.ts src/server/meshtasticManager.ts
git commit -m "refactor(virtual-node): remove global singleton and env-var startup"
```

---

### Task 5: Source CRUD validation — VN port rules

**Files:**
- Modify: `src/server/routes/sourceRoutes.ts`
- Modify: `src/server/routes/sourceRoutes.test.ts` (or create if absent)

- [ ] **Step 1: Locate the existing sourceRoutes test file**

Run: `ls src/server/routes/sourceRoutes.test.ts 2>/dev/null || echo MISSING`

If MISSING, create it with the usual Express test harness (see `src/server/routes/apiTokenRoutes.test.ts` for the established pattern — spin up the router, mock DatabaseService with async methods).

- [ ] **Step 2: Write the failing tests**

Add these tests to `sourceRoutes.test.ts`:

```ts
describe('sourceRoutes — virtual node validation', () => {
  it('rejects virtualNode config on non-meshtastic_tcp sources', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set('Cookie', adminCookie)
      .send({
        name: 'MQTT Feed',
        type: 'mqtt',
        config: {
          brokerUrl: 'mqtt://localhost:1883',
          virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virtual node.*only.*meshtastic_tcp/i);
  });

  it('rejects virtualNode port out of range', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set('Cookie', adminCookie)
      .send({
        name: 'Home',
        type: 'meshtastic_tcp',
        config: {
          host: '192.168.1.1',
          port: 4403,
          virtualNode: { enabled: true, port: 70000, allowAdminCommands: false },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/port/i);
  });

  it('rejects virtualNode port equal to the source upstream port', async () => {
    const res = await request(app)
      .post('/api/sources')
      .set('Cookie', adminCookie)
      .send({
        name: 'Home',
        type: 'meshtastic_tcp',
        config: {
          host: '192.168.1.1',
          port: 4403,
          virtualNode: { enabled: true, port: 4403, allowAdminCommands: false },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same as.*source port/i);
  });

  it('rejects virtualNode port that collides with another source', async () => {
    // Mock sources repo to return an existing source with VN on 4503
    (DatabaseService as any).sources.getAllSources = vi.fn().mockResolvedValue([
      {
        id: 'existing-src',
        name: 'Existing',
        type: 'meshtastic_tcp',
        config: { host: '10.0.0.1', port: 4403, virtualNode: { enabled: true, port: 4503, allowAdminCommands: false } },
        enabled: 1,
      },
    ]);

    const res = await request(app)
      .post('/api/sources')
      .set('Cookie', adminCookie)
      .send({
        name: 'New',
        type: 'meshtastic_tcp',
        config: {
          host: '10.0.0.2',
          port: 4403,
          virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
        },
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Existing/);
  });

  it('accepts valid virtualNode config', async () => {
    (DatabaseService as any).sources.getAllSources = vi.fn().mockResolvedValue([]);
    (DatabaseService as any).sources.createSource = vi.fn().mockResolvedValue({ id: 'new-src' });

    const res = await request(app)
      .post('/api/sources')
      .set('Cookie', adminCookie)
      .send({
        name: 'Home',
        type: 'meshtastic_tcp',
        config: {
          host: '192.168.1.1',
          port: 4403,
          virtualNode: { enabled: true, port: 4503, allowAdminCommands: true },
        },
      });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/server/routes/sourceRoutes.test.ts`
Expected: the 5 new tests fail.

- [ ] **Step 4: Add a validation helper in sourceRoutes.ts**

Add near the top of `src/server/routes/sourceRoutes.ts`:

```ts
/**
 * Validate a virtualNode config block. Returns an HTTP error object if invalid, null if OK.
 */
async function validateVirtualNodeConfig(
  sourceType: string,
  config: any,
  existingSourceId: string | null
): Promise<{ status: number; error: string } | null> {
  const vn = config?.virtualNode;
  if (!vn) return null;

  if (sourceType !== 'meshtastic_tcp') {
    return { status: 400, error: 'Virtual node is only supported on meshtastic_tcp sources' };
  }

  if (!vn.enabled) return null; // fields only matter when enabled

  const port = Number(vn.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 400, error: 'Virtual node port must be an integer between 1 and 65535' };
  }

  if (port === Number(config.port)) {
    return { status: 400, error: 'Virtual node port must not be the same as the source port' };
  }

  // Cross-source collision check
  const allSources = await databaseService.sources.getAllSources();
  for (const other of allSources) {
    if (other.id === existingSourceId) continue;
    const otherCfg: any = typeof other.config === 'string' ? JSON.parse(other.config) : other.config;
    if (otherCfg?.virtualNode?.enabled && Number(otherCfg.virtualNode.port) === port) {
      return {
        status: 409,
        error: `Virtual node port ${port} is already used by source "${other.name}"`,
      };
    }
  }

  return null;
}
```

- [ ] **Step 5: Call the helper from POST /api/sources**

In the create handler, before persisting:

```ts
const vnError = await validateVirtualNodeConfig(body.type, body.config, null);
if (vnError) return res.status(vnError.status).json({ error: vnError.error });
```

- [ ] **Step 6: Call the helper from PUT /api/sources/:id**

In the update handler, before persisting:

```ts
const vnError = await validateVirtualNodeConfig(body.type ?? existing.type, body.config, req.params.id);
if (vnError) return res.status(vnError.status).json({ error: vnError.error });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/server/routes/sourceRoutes.test.ts`
Expected: PASS (all 5 new tests + existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/sourceRoutes.ts src/server/routes/sourceRoutes.test.ts
git commit -m "feat(virtual-node): validate per-source VN port rules"
```

---

### Task 6: `SourceManagerRegistry.updateSource` hot-swap

**Files:**
- Modify: `src/server/sourceManagerRegistry.ts`
- Create: `src/server/sourceManagerRegistry.virtualNode.test.ts`

- [ ] **Step 1: Read the current `updateSource` implementation**

Run: `grep -n "updateSource\|reconfigure" src/server/sourceManagerRegistry.ts`

If no `updateSource` exists yet, add one that receives `(sourceId, newConfig)` and decides between hot-swap (VN-only change) and full restart (transport change).

- [ ] **Step 2: Write the failing test**

Create `src/server/sourceManagerRegistry.virtualNode.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceManagerRegistry } from './sourceManagerRegistry.js';

describe('SourceManagerRegistry — VN hot-swap', () => {
  let registry: SourceManagerRegistry;
  let mockManager: any;

  beforeEach(() => {
    registry = new SourceManagerRegistry();
    mockManager = {
      sourceId: 'src-1',
      config: {
        host: '127.0.0.1',
        port: 4403,
        virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
      },
      reconfigureVirtualNode: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    (registry as any).managers.set('src-1', mockManager);
  });

  it('hot-swaps VN when only virtualNode changed', async () => {
    await registry.updateSource('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4504, allowAdminCommands: true },
    });

    expect(mockManager.reconfigureVirtualNode).toHaveBeenCalledWith({
      enabled: true,
      port: 4504,
      allowAdminCommands: true,
    });
    expect(mockManager.stop).not.toHaveBeenCalled();
    expect(mockManager.start).not.toHaveBeenCalled();
  });

  it('full-restarts when host/port changed', async () => {
    await registry.updateSource('src-1', {
      host: '10.0.0.5',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });

    expect(mockManager.stop).toHaveBeenCalled();
    expect(mockManager.start).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run src/server/sourceManagerRegistry.virtualNode.test.ts`
Expected: FAIL — `updateSource` missing or no hot-swap path.

- [ ] **Step 4: Implement `updateSource`**

In `src/server/sourceManagerRegistry.ts`:

```ts
public async updateSource(sourceId: string, newConfig: any): Promise<void> {
  const manager = this.managers.get(sourceId);
  if (!manager) {
    throw new Error(`No manager for source ${sourceId}`);
  }

  const oldConfig = manager.config;
  const transportChanged =
    oldConfig.host !== newConfig.host || oldConfig.port !== newConfig.port;

  const vnChanged =
    JSON.stringify(oldConfig.virtualNode ?? null) !== JSON.stringify(newConfig.virtualNode ?? null);

  if (transportChanged) {
    // Full restart — updates both transport and VN
    await manager.stop();
    manager.config = newConfig;
    await manager.start();
    return;
  }

  if (vnChanged) {
    // Hot-swap VN only
    await manager.reconfigureVirtualNode(newConfig.virtualNode);
  }
}
```

- [ ] **Step 5: Wire `updateSource` into the PUT route**

In `src/server/routes/sourceRoutes.ts`, inside the PUT handler, after `databaseService.sources.updateSource(...)` succeeds, call:

```ts
try {
  await sourceManagerRegistry.updateSource(req.params.id, body.config);
} catch (err) {
  logger.error(`Failed to apply source update to running manager:`, err);
}
```

- [ ] **Step 6: Run tests**

Run: `./node_modules/.bin/vitest run src/server/sourceManagerRegistry.virtualNode.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/sourceManagerRegistry.ts src/server/sourceManagerRegistry.virtualNode.test.ts src/server/routes/sourceRoutes.ts
git commit -m "feat(virtual-node): registry hot-swaps VN on source update"
```

---

### Task 7: Dashboard source modal — Virtual Node form fields

**Files:**
- Modify: `src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add form state**

In `DashboardInner`, alongside the existing `formName`/`formHost`/`formPort` state (lines 50–53), add:

```tsx
const [formVnEnabled, setFormVnEnabled] = useState(false);
const [formVnPort, setFormVnPort] = useState('');
const [formVnAdmin, setFormVnAdmin] = useState(false);
```

- [ ] **Step 2: Reset the new fields in the add-path reset**

Find the block at lines 80–83 that resets `formName`/`formHost`/`formPort`/`formError` and add:

```tsx
setFormVnEnabled(false);
setFormVnPort('');
setFormVnAdmin(false);
```

- [ ] **Step 3: Hydrate the new fields in the edit-path**

Find the block at lines 92–95 that hydrates from `cfg` and add:

```tsx
setFormVnEnabled(Boolean(cfg?.virtualNode?.enabled));
setFormVnPort(String(cfg?.virtualNode?.port ?? ''));
setFormVnAdmin(Boolean(cfg?.virtualNode?.allowAdminCommands));
```

- [ ] **Step 4: Include VN in the submitted config**

In `onSaveSource` (starting at line 99), replace the existing `config: { host: formHost.trim(), port }` payload with:

```tsx
const configBody: any = { host: formHost.trim(), port };
if (formVnEnabled) {
  const vnPort = parseInt(formVnPort, 10);
  if (isNaN(vnPort) || vnPort < 1 || vnPort > 65535) {
    setFormError('Virtual node port must be 1–65535');
    setFormSaving(false);
    return;
  }
  if (vnPort === port) {
    setFormError('Virtual node port cannot equal the source port');
    setFormSaving(false);
    return;
  }
  configBody.virtualNode = {
    enabled: true,
    port: vnPort,
    allowAdminCommands: formVnAdmin,
  };
}
// …then use `config: configBody` in the fetch body
```

- [ ] **Step 5: Render the Virtual Node form section in the modal**

In the modal JSX, after the TCP Port field (after the closing `</label>` that ends around line 287), insert:

```tsx
<div className="dashboard-form-section" style={{ marginTop: 16, borderTop: '1px solid var(--ctp-surface1)', paddingTop: 12 }}>
  <label className="dashboard-form-field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <input
      type="checkbox"
      checked={formVnEnabled}
      onChange={(e) => setFormVnEnabled(e.target.checked)}
    />
    <span className="dashboard-form-label" style={{ margin: 0 }}>Enable Virtual Node</span>
  </label>

  {formVnEnabled && (
    <>
      <label className="dashboard-form-field">
        <span className="dashboard-form-label">Virtual Node Port</span>
        <input
          className="dashboard-form-input"
          type="number"
          value={formVnPort}
          onChange={(e) => setFormVnPort(e.target.value)}
          placeholder="4503"
        />
      </label>

      <label className="dashboard-form-field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={formVnAdmin}
          onChange={(e) => setFormVnAdmin(e.target.checked)}
        />
        <span className="dashboard-form-label" style={{ margin: 0 }}>
          Allow admin commands
        </span>
      </label>
      <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0 24px' }}>
        Third-party clients connected to the virtual node can send admin commands to your node. Leave off unless you trust the clients.
      </p>
    </>
  )}
</div>
```

- [ ] **Step 6: Show VN badge on source cards**

Find the source card render (search for where `source.name` is rendered with status). Add next to the status badge:

```tsx
{(source.config?.virtualNode?.enabled) && (
  <span className="dashboard-source-badge" title="Virtual Node running">
    VN:{source.config.virtualNode.port}
  </span>
)}
```

- [ ] **Step 7: Manual smoke test**

Run: `docker compose -f docker-compose.dev.yml up -d meshmonitor-sqlite`
Open `http://localhost:8081/meshmonitor`, log in as admin, open **Add Source** → verify the VN section toggle shows/hides port + admin fields → verify saving with colliding port surfaces a clear error.

- [ ] **Step 8: Commit**

```bash
git add src/pages/DashboardPage.tsx
git commit -m "feat(virtual-node): add VN fields to source add/edit modal"
```

---

### Task 8: System test — `tests/test-virtual-node.sh`

**Files:**
- Modify: `tests/test-virtual-node.sh`

- [ ] **Step 1: Read the current script**

Run: `cat tests/test-virtual-node.sh`

- [ ] **Step 2: Rewrite the launch step to use the API**

Replace env-var-based startup with:

1. Launch the container without `ENABLE_VIRTUAL_NODE` or `VIRTUAL_NODE_PORT`.
2. After login, `POST /api/sources` with a body that includes `virtualNode: { enabled: true, port: 4503, allowAdminCommands: true }`.
3. Wait for the manager to start and the VN server to bind.
4. Verify the existing assertions (TCP client can connect on the configured port, receives expected framed messages) work unchanged against the per-source VN.

Use `scripts/api-test.sh` helpers for the login + POST.

- [ ] **Step 3: Run the system test**

Run: `./tests/test-virtual-node.sh`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test-virtual-node.sh
git commit -m "test(virtual-node): drive system test via per-source API"
```

---

### Task 9: Release notes

**Files:**
- Modify: `CHANGELOG.md` (or the 4.0 release notes doc in the repo — if none, add an entry under a new "4.0" heading at the top of `CHANGELOG.md`)

- [ ] **Step 1: Add breaking-change entry**

Add under the 4.0 section:

```markdown
### Breaking Changes

- **Virtual Node is now per-source.** The `ENABLE_VIRTUAL_NODE`, `VIRTUAL_NODE_PORT`, and `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` environment variables have been removed. After upgrading, enable Virtual Node on each desired source via **Sources → Edit → Virtual Node**. Each source can now run its own Virtual Node on a distinct port with independent admin-command settings.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): breaking change — per-source virtual node"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full type-check and test suite**

Run: `npx tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 2: System tests**

Run: `./tests/system-tests.sh`
Expected: all system tests pass (single-source backward compat preserved; virtual node test uses the new API path).

- [ ] **Step 3: Manual multi-source smoke test**

1. Bring up the dev container.
2. Configure two `meshtastic_tcp` sources, one with VN on port 4503, the other with VN on port 4504 (use real or dummy hosts — the VN server starts even if upstream connect is still retrying).
3. `nc localhost 4503` and `nc localhost 4504` — verify each accepts a TCP connection independently.
4. Edit one source, change VN port 4503 → 4505, save, and verify hot-swap happened without the transport reconnecting (check logs for "Virtual node for source … reconfigured" without a transport reconnect log).

- [ ] **Step 4: Push branch**

```bash
git push origin feature/4.0
```
