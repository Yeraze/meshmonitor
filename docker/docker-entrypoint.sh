#!/bin/sh
set -e

# MeshMonitor container entrypoint (shared by the Alpine image and the
# Debian-based armv7 image).
#
# Privilege model (#5692)
# -----------------------
# Every long-running process — supervisord, the Node.js server and the Apprise
# API — runs as the unprivileged `node` user. When the container starts as
# root (the default for `docker run` / Compose), this script does the few jobs
# that need root and then drops privilege with su-exec (Alpine) or gosu
# (Debian) before it execs supervisord:
#
#   1. PUID/PGID: renumber the `node` user/group to match host ownership.
#   2. Serial devices: add `node` to the group that owns each mapped
#      /dev/tty* device, so the server can open it.
#   3. /data ownership: fix files left owned by root (or by an old PUID).
#      The full recursive pass runs ONCE per owner — a marker in /data
#      records the uid:gid it was done for, so later starts only check the
#      top level of /data instead of walking the whole tree.
#
# When the container starts as a non-root user (Kubernetes `runAsUser`,
# Compose `user: "1000:1000"`), none of that is possible or needed: the steps
# are skipped and supervisord runs as whatever user the container was given.
#
# Escape hatch: RUN_AS_ROOT=true keeps the pre-#5692 behaviour of running
# supervisord and Apprise as root. It exists only for troubleshooting an
# upgrade; do not leave it on.

RUNNING_AS_ROOT=false
if [ "$(id -u)" = "0" ]; then
    RUNNING_AS_ROOT=true
fi

# Privilege-drop helper: su-exec on Alpine, gosu on Debian (armv7 image).
DROP_PRIV=""
if command -v su-exec >/dev/null 2>&1; then
    DROP_PRIV="su-exec"
elif command -v gosu >/dev/null 2>&1; then
    DROP_PRIV="gosu"
fi

# Portable group helpers. Alpine ships busybox addgroup/adduser; Debian ships
# the adduser package (addgroup --gid) and shadow (groupadd/usermod). Try each.
create_group_with_gid() {
    # $1 = gid, $2 = name
    addgroup -g "$1" "$2" 2>/dev/null \
        || groupadd -g "$1" "$2" 2>/dev/null \
        || addgroup --gid "$1" "$2" 2>/dev/null \
        || true
}
add_node_to_group() {
    # $1 = group name
    addgroup node "$1" 2>/dev/null \
        || usermod -a -G "$1" node 2>/dev/null \
        || adduser node "$1" 2>/dev/null
}

# PUID/PGID Support (only when running as root)
# If PUID and/or PGID environment variables are set, modify the node user/group
# to match those IDs. This is useful for NAS systems like Synology where the
# host directory ownership may differ from the default container user.
#
# Note: Alpine Linux doesn't have usermod/groupmod, so we use sed to modify
# /etc/passwd and /etc/group directly. This works on Debian as well.

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$RUNNING_AS_ROOT" = "true" ]; then
    # Validate PUID/PGID are numeric and in valid range (0-65534)
    validate_id() {
        local id="$1"
        local name="$2"
        if ! echo "$id" | grep -qE '^[0-9]+$'; then
            echo "ERROR: $name must be a numeric value, got: $id" >&2
            exit 1
        fi
        if [ "$id" -lt 0 ] || [ "$id" -gt 65534 ]; then
            echo "ERROR: $name must be between 0 and 65534, got: $id" >&2
            exit 1
        fi
    }

    validate_id "$PUID" "PUID"
    validate_id "$PGID" "PGID"

    # Get current node user/group IDs
    CURRENT_UID=$(id -u node)
    CURRENT_GID=$(id -g node)

    # Track if we need to update the GID in passwd (only if PGID actually changed)
    NEW_GID="$CURRENT_GID"

    # Only modify group if GID differs from current
    if [ "$PGID" != "$CURRENT_GID" ]; then
        echo "Setting node group GID to $PGID..."
        # Delete existing group with target GID if it exists (and isn't node's group)
        EXISTING_GROUP=$(getent group "$PGID" 2>/dev/null | cut -d: -f1 || true)
        if [ -n "$EXISTING_GROUP" ] && [ "$EXISTING_GROUP" != "node" ]; then
            echo "  Removing conflicting group: $EXISTING_GROUP"
            delgroup "$EXISTING_GROUP" 2>/dev/null || groupdel "$EXISTING_GROUP" 2>/dev/null || true
        fi
        # Modify node group GID in /etc/group
        sed -i "s/^node:x:$CURRENT_GID:/node:x:$PGID:/" /etc/group
        NEW_GID="$PGID"
    fi

    # Only modify user if UID differs from current
    if [ "$PUID" != "$CURRENT_UID" ]; then
        echo "Setting node user UID to $PUID..."
        # Delete existing user with target UID if it exists (and isn't node)
        EXISTING_USER=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1 || true)
        if [ -n "$EXISTING_USER" ] && [ "$EXISTING_USER" != "node" ]; then
            echo "  Removing conflicting user: $EXISTING_USER"
            deluser "$EXISTING_USER" 2>/dev/null || userdel "$EXISTING_USER" 2>/dev/null || true
        fi
        # Modify node user UID and GID in /etc/passwd
        sed -i "s/^node:x:$CURRENT_UID:$CURRENT_GID:/node:x:$PUID:$NEW_GID:/" /etc/passwd
    elif [ "$NEW_GID" != "$CURRENT_GID" ]; then
        # UID unchanged but GID changed - update GID reference in passwd
        sed -i "s/^node:x:$CURRENT_UID:$CURRENT_GID:/node:x:$CURRENT_UID:$NEW_GID:/" /etc/passwd
    fi
else
    echo "Running as non-root (UID $(id -u)), skipping PUID/PGID, device-group and ownership setup"
    echo "  (Kubernetes fsGroup / Compose group_add must grant access to /data and any serial device)"
fi

# Serial device access: when /dev/tty* devices are mapped into the container,
# the host's owning GIDs are usually not among the node user's groups. Docker's
# `group_add` does not help here, because the privilege drop below rebuilds the
# supplementary groups from /etc/group. So add node to each device's owning
# group by GID, creating the group if the image has no group with that GID.
# Devices hot-plugged after the container starts are not covered: restart it.
if [ "$RUNNING_AS_ROOT" = "true" ]; then
    for dev in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyS*; do
        [ -e "$dev" ] || continue
        DEV_GID=$(stat -L -c '%g' "$dev" 2>/dev/null || true)
        [ -n "$DEV_GID" ] || continue
        # gid 0 means the device is root-owned; granting node the root group
        # would hand it far more than one tty. Leave those alone.
        [ "$DEV_GID" != "0" ] || continue
        # Skip if node already has this gid (primary or supplementary)
        if id node | grep -qE "(^|[=,])${DEV_GID}([(,]|$)"; then
            continue
        fi
        GROUP_NAME=$(getent group "$DEV_GID" 2>/dev/null | cut -d: -f1 || true)
        if [ -z "$GROUP_NAME" ]; then
            GROUP_NAME="ttydev${DEV_GID}"
            create_group_with_gid "$DEV_GID" "$GROUP_NAME"
        fi
        if [ -n "$GROUP_NAME" ] && add_node_to_group "$GROUP_NAME"; then
            echo "✓ Granted node user access to $dev via group $GROUP_NAME (gid $DEV_GID)"
        else
            echo "⚠️  Could not add node to the group owning $dev (gid $DEV_GID); the server may not be able to open it" >&2
        fi
    done
fi

# Internal MeshMonitor scripts directory (never bind-mounted).
INTERNAL_SCRIPTS_DIR="/data/.meshmonitor-internal"

# Create directories (as root when we are root; the ownership pass below
# covers them). /data/scripts is for USER scripts and may be bind-mounted, so
# we don't create it here.
mkdir -p "$INTERNAL_SCRIPTS_DIR" /data/logs /data/apprise-config

# /data ownership. Only possible as root; in Kubernetes with runAsNonRoot,
# fsGroup handles permissions instead.
#
# Old images ran supervisord and Apprise as root, and `docker exec` defaults to
# root, so a volume can hold root-owned files the unprivileged server cannot
# write. The old entrypoint ran `chown -R /data` on EVERY start; on a large
# volume (backups, tiles, firmware) that walk was slow and rewrote the ctime of
# every file. Now:
#   - every start: fix the top level of /data only (the DB, its -wal/-shm, and
#     the directories) — cheap, and catches the common `docker exec` case;
#   - once per owner: a recursive pass that touches only the files whose owner
#     is wrong. A marker records the uid:gid it was done for; changing
#     PUID/PGID changes the expected owner, which re-runs it once.
# MESHMONITOR_FORCE_CHOWN=true forces the recursive pass on this start.
if [ "$RUNNING_AS_ROOT" = "true" ]; then
    RUNTIME_OWNER="$(id -u node):$(id -g node)"
    OWNER_MARKER="$INTERNAL_SCRIPTS_DIR/.data-owner"

    find /data -maxdepth 1 \( ! -user node -o ! -group node \) \
        -exec chown node:node {} + 2>/dev/null \
        || echo "⚠️  Could not fix ownership of some entries in /data (read-only mount?)" >&2

    MARKER_OWNER=$(cat "$OWNER_MARKER" 2>/dev/null || true)
    case "$MESHMONITOR_FORCE_CHOWN" in
        1|true|TRUE|yes|YES|on|ON) MARKER_OWNER="" ;;
    esac
    if [ "$MARKER_OWNER" != "$RUNTIME_OWNER" ]; then
        echo "Fixing ownership of /data for node ($RUNTIME_OWNER) — one-time pass, may take a while on a large volume..."
        if find /data \( ! -user node -o ! -group node \) -exec chown -h node:node {} + ; then
            echo "✓ /data ownership fixed; later starts will skip the full pass"
        else
            # Usually a read-only bind mount (e.g. /data/scripts:ro). Retrying
            # on every start would not fix that and would re-walk the whole
            # volume each time, so record the pass anyway and say so.
            echo "⚠️  Some files under /data could not be chowned (read-only bind mount?)." >&2
            echo "    Fix them on the host, or set MESHMONITOR_FORCE_CHOWN=true to retry on the next start." >&2
        fi
        echo "$RUNTIME_OWNER" > "$OWNER_MARKER"
        chown node:node "$OWNER_MARKER"
    fi

    # dist/ is chowned to node at build time and is only read at runtime, so
    # this matters only when PUID/PGID renumbered node. One stat when it doesn't.
    if [ "$(stat -c '%u:%g' /app/dist)" != "$RUNTIME_OWNER" ]; then
        chown -R node:node /app/dist
    fi
fi

# Auto-Upgrade Retirement (v4.13): in-app upgrade execution was removed.
# Best-effort cleanup of stale trigger/status files and the retired watchdog
# scripts left behind by earlier versions. Safe to run every boot.
rm -f /data/.upgrade-trigger \
      /data/.upgrade-status \
      /data/.docker-socket-test* \
      "$INTERNAL_SCRIPTS_DIR/upgrade-watchdog.sh" \
      "$INTERNAL_SCRIPTS_DIR/test-docker-socket.sh" \
      /data/scripts/upgrade-watchdog.sh 2>/dev/null || true

# AUTO_UPGRADE_ENABLED is no longer supported. Warn once if it is still set.
case "$AUTO_UPGRADE_ENABLED" in
    1|true|TRUE|yes|YES|on|ON)
        echo "⚠️  AUTO_UPGRADE_ENABLED is no longer supported (in-app upgrades were removed in v4.13)." >&2
        echo "    See https://yeraze.github.io/meshmonitor/configuration/updating for update instructions." >&2
        ;;
esac

# Image integrity check (issue #3542): a corrupt or incomplete image pull can
# leave dist/server/server.js as a 0-byte file. Node then exits 0 immediately,
# supervisord retries to FATAL, and the container crash-loops with no actionable
# message beyond "exited: meshmonitor (exit status 0; not expected)". Verify the
# server bundle is present and non-empty here so the real cause is visible in
# `docker compose logs` instead.
SERVER_ENTRY="/app/dist/server/server.js"
if [ ! -s "$SERVER_ENTRY" ]; then
    echo "❌ FATAL: $SERVER_ENTRY is missing or empty — the image may be corrupt or incompletely pulled." >&2
    echo "   Fix: remove the cached image and re-pull, e.g.:" >&2
    echo "        docker rmi <meshmonitor image> && docker compose pull && docker compose up -d" >&2
    exit 1
fi
echo "✓ Server bundle present ($(wc -c < "$SERVER_ENTRY") bytes)"

if [ "$RUNNING_AS_ROOT" = "true" ]; then
    case "$RUN_AS_ROOT" in
        1|true|TRUE|yes|YES|on|ON)
            echo "⚠️  RUN_AS_ROOT is set: supervisord and Apprise will run as root (pre-4.17 behaviour)." >&2
            echo "    This is a troubleshooting escape hatch only — unset it once the upgrade issue is fixed." >&2
            exec "$@"
            ;;
    esac
    if [ -z "$DROP_PRIV" ]; then
        echo "❌ FATAL: neither su-exec nor gosu is installed; refusing to run the server as root." >&2
        exit 1
    fi
    # supervisord re-opens /dev/stdout and /dev/stderr for each program's log
    # stream. Docker hands the container root-owned 0600 pipes (or a root-owned
    # pty with -t), so once supervisord is node that open fails with EACCES and
    # every program goes FATAL ("unknown error making dispatchers"). Give the
    # container's own stdout/stderr to node. Only pipes and terminals: never
    # chown a regular file or /dev/null that stdout happens to point at.
    # No `2>/dev/null` on the chown: that redirect would make fd 2 /dev/null
    # for the chown itself, so it would chown /dev/null instead of stderr.
    for fd in 1 2; do
        if [ -p "/proc/self/fd/$fd" ] || [ -t "$fd" ]; then
            chown node "/proc/self/fd/$fd" || true
        fi
    done

    echo "Dropping privileges to node ($(id -u node):$(id -g node)) via $DROP_PRIV"
    exec "$DROP_PRIV" node "$@"
fi

# Already non-root: supervisord.conf has no user= directive and a /tmp
# pidfile, so it runs unchanged as the current user.
exec "$@"
