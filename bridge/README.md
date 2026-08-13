# meshmonitor-rns-bridge

A small Python sidecar that speaks the [Reticulum Network Stack](https://reticulum.network/)
(`rns`) on one side and a JSON-over-WebSocket protocol to MeshMonitor's Node backend on the
other. See `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §4 for the full design
and `docs/internal/dev-notes/RETICULUM_WP0_SPIKE_EVIDENCE.md` for the empirical findings this
implementation is built on.

**License note:** `rns`/`lxmf` carry the non-OSI Reticulum License. This sidecar ships them in
its own image only -- see `NOTICE` for the full disclosure. Never add `rns`/`lxmf` to the main
MeshMonitor `package.json` or `node:24` image.

## Two connection modes

- **`attach`** (default): connects to an *existing* `rnsd`/shared Reticulum instance as a
  client. Needs a readable RNS config directory (typically the user's `~/.reticulum`, bind-
  mounted read-only or read-write). Safe by design -- client instances never open interfaces
  themselves (WP0 spike evidence §2), so attaching cannot double-open a serial port or disturb
  the running `rnsd`.
- **`tcp_peer`**: the bridge runs its *own* standalone RNS instance and connects out to one or
  more `TCPClientInterface` peers you specify. No local `rnsd`/config dir needed, but you lose
  the interface-stats/rssi data that only a shared instance's local interfaces expose.

## Running it

Build and run directly with Docker:

```bash
docker build -t meshmonitor-rns-bridge bridge/

docker run --rm \
  --network host \
  -v "$HOME/.reticulum:/rns:ro" \
  -e BRIDGE_TOKEN=change-me \
  -e RNS_MODE=attach \
  -e RNS_CONFIG_DIR=/rns \
  meshmonitor-rns-bridge
```

`--network host` is required for `attach` mode on Linux: `rnsd`'s shared-instance RPC socket
binds to `127.0.0.1` by default, and the bridge needs to reach it directly. `tcp_peer` mode does
not need host networking or the config-dir mount.

`tcp_peer` mode runs the bridge's own standalone RNS instance and joins the network by dialing
out to one or more `TCPClientInterface` peers -- no local `rnsd`, no config-dir mount, no
`--network host`:

```bash
docker run --rm \
  -p 8765:8765 \
  -e BRIDGE_TOKEN=change-me \
  -e RNS_MODE=tcp_peer \
  -e RNS_TCP_PEERS=amsterdam.connect.reticulum.network:4965,rns.example.org:4242 \
  meshmonitor-rns-bridge
```

Whichever mode you start with, the env vars below are just the defaults used before Node's first
`configure` handshake message arrives -- see "Configuration" next.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `BRIDGE_HOST` | `0.0.0.0` | WebSocket listen address |
| `BRIDGE_PORT` | `8765` | WebSocket listen port |
| `BRIDGE_TOKEN` | *(required)* | Shared secret checked on the `hello` handshake |
| `RNS_MODE` | `attach` | `attach` \| `tcp_peer` (may be overridden per-session by Node's `configure` message) |
| `RNS_CONFIG_DIR` | *(none)* | Path to the RNS config dir (attach mode); also usable as the standalone instance's config dir in tcp_peer mode |
| `RNS_TCP_PEERS` | *(none)* | Comma-separated `host:port,host:port` list; required when `RNS_MODE=tcp_peer` |
| `PROTOCOL_VERSION` | `1` | Wire protocol version advertised in `welcome` |
| `BRIDGE_STATS_INTERVAL_S` | `5` | Interface-stats poll interval |
| `BRIDGE_PATHS_INTERVAL_S` | `15` | Path-table poll interval |
| `BRIDGE_LOG_LEVEL` | `info` | Python `logging` level name |

Mode/config-dir/peers can also be set (or overridden) per-connection by Node's `configure`
message -- see the wire protocol section of the build spec. Env vars are the fallback used when
running/testing the bridge standalone.

## Troubleshooting `rpc_key` / `RPC_AUTH_FAILED`

The single most likely misconfiguration in `attach` mode. Two RNS instances must agree on an
`rpc_key` to exchange interface stats / path table / signal data over the shared-instance RPC
channel. By default this key is *derived from the config directory's transport identity*
(`RNS.Reticulum.rpc_key = full_hash(Transport._identity.private_key)`), which means:

- **If the bridge is pointed at the *same* config directory as your `rnsd`** (the normal,
  recommended setup -- bind-mount `~/.reticulum` into the container), the keys match
  automatically. No action needed.
- **If you deliberately run the bridge against a *separate* config directory** (e.g. you don't
  want to share your main config dir), you must set an explicit, matching `rpc_key` in both
  `rnsd`'s config file and the bridge's config directory's config file, under `[reticulum]`:

  ```ini
  [reticulum]
    rpc_key = <same 64-char hex string in both configs>
  ```

  There is no bridge-side environment variable for this -- it's an RNS config-file setting, not
  a bridge setting, because it has to match on both sides of the RPC channel.

**What you'll observe when this is wrong:** the initial attach itself *succeeds* -- `attached:
true`-equivalent status, no error on `configure` -- because the packet-forwarding path
(`LocalClientInterface`) only depends on the ifac (interface access control) key, not
`rpc_key`. The mismatch only surfaces on the *first* interface-stats poll, which opens a
separate authenticated RPC channel and fails with `RPC_AUTH_FAILED`. If you see `configure`
succeed (`ready`) but then an `error` event with `code: "RPC_AUTH_FAILED"` shortly after,
this is almost always the cause.

## Other failure codes

| Code | Meaning | Fix |
|---|---|---|
| `CONFIGDIR_UNREADABLE` | `RNS_CONFIG_DIR` doesn't exist, isn't a directory, or isn't readable by the bridge's user | Check the mount and container user/group; the bridge runs as a non-root `bridge` user (Dockerfile) |
| `NO_SHARED_INSTANCE` | `attach` mode, but no `rnsd`/shared instance is listening at the configured socket | Start `rnsd` first, or point `RNS_CONFIG_DIR` at a config where one is running |
| `RPC_AUTH_FAILED` | `rpc_key` mismatch -- see above | Share the config dir, or set matching explicit `rpc_key`s |
| `TCP_PEER_UNREACHABLE` | `tcp_peer` mode, none of the configured `RNS_TCP_PEERS` accepted a connection within the initial connect timeout | Check host/port and that the peer is reachable from the container's network |
| `RNS_INIT_FAILED` | Any other RNS startup failure not covered above | Check `BRIDGE_LOG_LEVEL=debug` output for the underlying exception |
| `PROTOCOL_VERSION_MISMATCH` | Node and bridge disagree on wire protocol version | Update one side; both must speak the same `PROTOCOL_VERSION` |
| `AUTH_FAILED` | `hello.token` didn't match `BRIDGE_TOKEN` | Check the token configured on the Node source matches the bridge's env var |

## Why the bridge exits on repeated RNS failures

`RNS.Reticulum` is a process-wide singleton with no supported way to detach and reattach within
the same process (confirmed empirically, see WP0 spike evidence §6.4). So when the bridge's
interface-stats poller sees several consecutive failures in a row (e.g. `rnsd` restarted
underneath it and the RPC socket died), it does **not** try to hot-reattach -- it logs, requests
a clean shutdown, and exits with code `1`. Run this container with `restart: unless-stopped` (or
your orchestrator's equivalent) so a fresh process comes up and attaches cleanly. This mirrors
how `rnstatus`/NomadNet expect to be run and is deliberately simple: "the bridge is stateless
beyond its RNS instance, restarting it is always safe."

## Tests

```bash
pip install -r requirements.txt -r requirements-test.txt
pytest bridge/tests
```

`bridge/tests/integration/test_dual_rnsd.py` needs the `rnsd` binary on `PATH` (installed by
`rns`, part of `requirements.txt`) and spawns real `rnsd` subprocesses on loopback -- no
hardware, no network access beyond `127.0.0.1`, required. If `rnsd` isn't on `PATH` the module
*skips* (not fails) rather than erroring, so a `pytest` run without it installed will report
fewer tests, not a failure.

CI (`.github/workflows/reticulum-bridge.yml`) runs the full suite -- both `test_protocol.py` and
the dual-`rnsd` integration tests -- on every PR/push touching `bridge/**`, in a fresh
`python:3.12` + `rns==1.4.2` environment. It is hardware-free and self-contained: two `rnsd`
processes talking over `TCPServerInterface` on loopback, no radio, no external network access.

### Contract-drift guard (Python <-> TypeScript)

`bridge/tests/fixtures/*.json` is the golden wire contract: the Node side
(`src/server/reticulumBridgeClient.test.ts`, WP3) parses these files directly, so Python's
`protocol.py` and the Node client can never silently disagree on message shape. The fixture
content is defined once, in `bridge/tests/fixture_builders.py`, and consumed two ways:

- `pytest bridge/tests` (specifically `test_protocol.py::test_fixture_matches_live_builder_output`)
  asserts the checked-in JSON still matches `protocol.py`'s live builder output.
- `python bridge/tests/generate_fixtures.py` (re)writes `bridge/tests/fixtures/*.json` from the
  same builders -- the fix-it counterpart to the pytest assertion above.

After changing a message-builder function in `protocol.py` (or its fixture arguments in
`fixture_builders.py`), regenerate and commit the diff:

```bash
python bridge/tests/generate_fixtures.py
git diff bridge/tests/fixtures
```

CI runs the same regeneration and fails the build if it produces any diff, i.e. if the
checked-in fixtures are stale relative to `protocol.py` -- this catches drift even in the (should
never happen) case where a fixture file is hand-edited without a matching `protocol.py` change.
