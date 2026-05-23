#!/bin/bash
#
# MeshMonitor LXC Update Script
#
# Run this on the Proxmox host as root. It performs a destroy-and-recreate
# update of an existing MeshMonitor LXC container, preserving:
#
#   - /data (database, apprise config, logs, system-backups)
#   - /etc/meshmonitor/meshmonitor.env (node IP, ALLOWED_ORIGINS, secrets)
#   - The container's current static IP (by default)
#
# It uses the canonical systemd units that ship inside the MeshMonitor LXC
# template, so this script does NOT need to be updated when service files
# change in the template.
#
# Usage:
#
#   ./update.sh --ctid 100 --version 4.6.5
#   ./update.sh --ctid 100                              # auto-detect latest version
#   CTID=100 CONFIRM=YES_DESTROY ./update.sh            # non-interactive
#
# Originally contributed by @mjwgeek in
# https://github.com/Yeraze/meshmonitor/issues/3144 and generalized for
# distribution with MeshMonitor.

set -euo pipefail

# -----------------------------------------------------------------------------
# Configurable values (override via env or CLI flags)
# -----------------------------------------------------------------------------

CTID="${CTID:-}"
MESHMONITOR_VERSION="${MESHMONITOR_VERSION:-}"    # empty = auto-detect latest

# Network mode: preserve_current_static | dhcp | custom_static
NETWORK_MODE="${NETWORK_MODE:-preserve_current_static}"
CUSTOM_IP_CONFIG="${CUSTOM_IP_CONFIG:-}"

# Container resources (only used if reading from old CT fails or in --fresh mode).
HOSTNAME_OVERRIDE="${HOSTNAME_OVERRIDE:-}"
STORAGE="${STORAGE:-}"
ROOTFS_SIZE="${ROOTFS_SIZE:-}"
BRIDGE="${BRIDGE:-}"
CORES="${CORES:-}"
MEMORY="${MEMORY:-}"
SWAP="${SWAP:-}"
UNPRIVILEGED="${UNPRIVILEGED:-}"
ONBOOT="${ONBOOT:-}"

# pct create --features value. Default matches the canonical template config.
# Set to e.g. "nesting=1" to enable nested workloads inside the CT.
CT_FEATURES="${CT_FEATURES:-nesting=0}"

# Safety: must equal YES_DESTROY (or YES_DESTROY_<CTID>) to actually proceed.
CONFIRM="${CONFIRM:-}"

# Pre-update Proxmox snapshot (best-effort; storage must support snapshots).
TAKE_SNAPSHOT="${TAKE_SNAPSHOT:-1}"

# Optional behaviors (all opt-in / off by default unless noted).
RESTORE_DATA="${RESTORE_DATA:-1}"
RESTORE_ENV_FILE="${RESTORE_ENV_FILE:-1}"
INSTALL_SSH="${INSTALL_SSH:-0}"          # opt-in: install + enable root SSH
RESTORE_ROOT_PASSWORD="${RESTORE_ROOT_PASSWORD:-0}"  # opt-in
KEEP_TEMPLATE="${KEEP_TEMPLATE:-1}"      # keep downloaded template after update

# Backup retention: prune meshmonitor-ct<CTID>-* files in BACKUP_DIR older
# than this many days. 0 = never prune (operator-managed).
KEEP_BACKUPS_DAYS="${KEEP_BACKUPS_DAYS:-0}"

BACKUP_DIR="${BACKUP_DIR:-/root/meshmonitor-lxc-backups}"
TEMPLATE_DIR="${TEMPLATE_DIR:-/var/lib/vz/template/cache}"
GITHUB_REPO="${GITHUB_REPO:-Yeraze/meshmonitor}"

# -----------------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------------

usage() {
    cat <<'USAGE'
MeshMonitor LXC update script

Usage: update.sh --ctid <id> [options]

Required:
  --ctid <id>                Container ID to update.

Common options:
  --version <x.y.z>          MeshMonitor release to install (default: auto-detect latest).
  --network <mode>           preserve_current_static (default) | dhcp | custom_static
  --custom-ip <cidr,gw=...>  Used with --network custom_static (e.g. "192.168.1.50/24,gw=192.168.1.1").
  --features <str>           pct create --features value (default: "nesting=0"). Use "nesting=1"
                             if you need nested containers/Docker inside the CT.
  --keep-backups-days <N>    Prune meshmonitor-ct<CTID>-* backups older than N days (default: 0 = never).
  --no-snapshot              Skip pre-update Proxmox snapshot.
  --install-ssh              Install/enable openssh-server with root password login (opt-in).
  --restore-root-password    Restore the old root password hash to the new container (opt-in).
  --yes                      Skip interactive confirmation (equivalent to CONFIRM=YES_DESTROY).
  -h, --help                 Show this help.

Environment variables override defaults (see top of script). CLI flags override env.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --ctid)               CTID="$2"; shift 2 ;;
        --version)            MESHMONITOR_VERSION="$2"; shift 2 ;;
        --network)            NETWORK_MODE="$2"; shift 2 ;;
        --custom-ip)          CUSTOM_IP_CONFIG="$2"; NETWORK_MODE="custom_static"; shift 2 ;;
        --features)           CT_FEATURES="$2"; shift 2 ;;
        --keep-backups-days)  KEEP_BACKUPS_DAYS="$2"; shift 2 ;;
        --no-snapshot)        TAKE_SNAPSHOT="0"; shift ;;
        --install-ssh)        INSTALL_SSH="1"; shift ;;
        --restore-root-password) RESTORE_ROOT_PASSWORD="1"; shift ;;
        --yes)                CONFIRM="YES_DESTROY"; shift ;;
        -h|--help)            usage; exit 0 ;;
        *)                    echo "Unknown argument: $1"; usage; exit 2 ;;
    esac
done

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log()  { printf '[+] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }
fail() { printf '[-] %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }

ct_exists()  { pct status "$CTID" >/dev/null 2>&1; }
ct_running() { pct status "$CTID" 2>/dev/null | grep -q "status: running"; }

ct_config_value() {
    # Reads a `key:` line from `pct config` and returns the trimmed value.
    pct config "$CTID" 2>/dev/null | awk -F': ' -v k="$1" '$1 == k { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }'
}

confirm_destroy() {
    local expected_a="YES_DESTROY"
    local expected_b="YES_DESTROY_${CTID}"
    if [ "$CONFIRM" = "$expected_a" ] || [ "$CONFIRM" = "$expected_b" ]; then
        return 0
    fi
    if [ ! -t 0 ]; then
        fail "Refusing to destroy CT ${CTID} without confirmation. Pass --yes or set CONFIRM=${expected_a}."
    fi
    echo
    warn "About to STOP, BACK UP, and DESTROY CT ${CTID}, then recreate it from the new template."
    warn "Data and env will be restored from backup. The container's IP will be preserved."
    read -r -p "Type '${expected_b}' to continue: " reply
    if [ "$reply" != "$expected_b" ]; then
        fail "Confirmation did not match. Aborting."
    fi
}

detect_latest_version() {
    local effective
    effective="$(curl -sSLI -o /dev/null -w '%{url_effective}' "https://github.com/${GITHUB_REPO}/releases/latest")"
    # effective will be ".../releases/tag/v4.6.5"
    local tag="${effective##*/}"
    tag="${tag#v}"
    if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
        fail "Failed to auto-detect latest version. Pass --version explicitly."
    fi
    printf '%s' "$tag"
}

# Reads container resources from the current CT and exports defaults if the
# user did not override them. Falls back to sensible defaults if the value is
# unreadable.
read_ct_resources() {
    [ -z "$HOSTNAME_OVERRIDE" ] && HOSTNAME_OVERRIDE="$(ct_config_value hostname)"
    [ -z "$HOSTNAME_OVERRIDE" ] && HOSTNAME_OVERRIDE="meshmonitor"

    [ -z "$CORES" ]        && CORES="$(ct_config_value cores)"
    [ -z "$CORES" ]        && CORES="2"
    [ -z "$MEMORY" ]       && MEMORY="$(ct_config_value memory)"
    [ -z "$MEMORY" ]       && MEMORY="2048"
    [ -z "$SWAP" ]         && SWAP="$(ct_config_value swap)"
    [ -z "$SWAP" ]         && SWAP="512"
    [ -z "$UNPRIVILEGED" ] && UNPRIVILEGED="$(ct_config_value unprivileged)"
    [ -z "$UNPRIVILEGED" ] && UNPRIVILEGED="1"
    [ -z "$ONBOOT" ]       && ONBOOT="$(ct_config_value onboot)"
    [ -z "$ONBOOT" ]       && ONBOOT="1"

    # rootfs format: "storage:vm-<id>-disk-0,size=20G"
    local rootfs storage_part size_part
    rootfs="$(ct_config_value rootfs)"
    if [ -z "$STORAGE" ] && [ -n "$rootfs" ]; then
        storage_part="${rootfs%%:*}"
        STORAGE="$storage_part"
    fi
    if [ -z "$ROOTFS_SIZE" ] && [ -n "$rootfs" ]; then
        size_part="$(printf '%s' "$rootfs" | sed -n 's/.*size=\([0-9]*\)G.*/\1/p')"
        [ -n "$size_part" ] && ROOTFS_SIZE="$size_part"
    fi
    [ -z "$ROOTFS_SIZE" ] && ROOTFS_SIZE="10"

    # net0 format: "name=eth0,bridge=vmbr0,ip=..."
    local net0
    net0="$(ct_config_value net0)"
    if [ -z "$BRIDGE" ] && [ -n "$net0" ]; then
        BRIDGE="$(printf '%s' "$net0" | sed -n 's/.*bridge=\([^,]*\).*/\1/p')"
    fi
    [ -z "$BRIDGE" ] && BRIDGE="vmbr0"
}

# Reads current IP/gateway from the (running) container and sets
# EFFECTIVE_IP_CONFIG accordingly. Falls back to DHCP if unreadable.
resolve_network_config() {
    case "$NETWORK_MODE" in
        dhcp)
            EFFECTIVE_IP_CONFIG="dhcp"
            log "Network mode: DHCP"
            ;;
        custom_static)
            if [ -z "$CUSTOM_IP_CONFIG" ]; then
                fail "NETWORK_MODE=custom_static requires --custom-ip or CUSTOM_IP_CONFIG."
            fi
            EFFECTIVE_IP_CONFIG="$CUSTOM_IP_CONFIG"
            log "Network mode: custom static (${EFFECTIVE_IP_CONFIG})"
            ;;
        preserve_current_static)
            local ip_cidr gw net0 cfg_ip cfg_gw
            ip_cidr="$(pct exec "$CTID" -- bash -c "ip -o -4 addr show dev eth0 | awk '{print \$4; exit}'" 2>/dev/null || true)"
            gw="$(pct exec "$CTID" -- bash -c "ip route show default | awk '{print \$3; exit}'" 2>/dev/null || true)"

            # Fallback: parse net0 from pct config when the CT is stopped or has no IP.
            if [ -z "$ip_cidr" ] || [ -z "$gw" ]; then
                net0="$(ct_config_value net0)"
                # net0 looks like: name=eth0,bridge=vmbr0,ip=10.0.0.5/24,gw=10.0.0.1
                cfg_ip="$(printf ',%s' "$net0" | sed -n 's/.*,ip=\([^,]*\).*/\1/p')"
                cfg_gw="$(printf ',%s' "$net0" | sed -n 's/.*,gw=\([^,]*\).*/\1/p')"
                if [ -n "$cfg_ip" ] && [ "$cfg_ip" != "dhcp" ]; then
                    ip_cidr="$cfg_ip"
                    [ -n "$cfg_gw" ] && gw="$cfg_gw"
                fi
            fi

            if [ -n "$ip_cidr" ] && [ "$ip_cidr" != "dhcp" ]; then
                if [ -n "$gw" ]; then
                    EFFECTIVE_IP_CONFIG="${ip_cidr},gw=${gw}"
                else
                    EFFECTIVE_IP_CONFIG="${ip_cidr}"
                    warn "Preserving IP but no default gateway found; the rebuilt CT may have no outbound route."
                fi
                log "Preserving network config: ${EFFECTIVE_IP_CONFIG}"
            else
                warn "Could not read current IP/gateway for CT ${CTID}; falling back to DHCP."
                warn "If a reverse proxy targets the CT by IP, update it after the rebuild."
                EFFECTIVE_IP_CONFIG="dhcp"
            fi
            ;;
        *)
            fail "Unknown NETWORK_MODE: ${NETWORK_MODE}"
            ;;
    esac
}

wait_for_network() {
    local tries=30
    local ip=""
    log "Waiting for container network..."
    for _ in $(seq 1 "$tries"); do
        ip="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
        if [ -n "$ip" ]; then
            printf '%s' "$ip"
            return 0
        fi
        sleep 2
    done
    return 1
}

# -----------------------------------------------------------------------------
# Steps
# -----------------------------------------------------------------------------

download_template() {
    local tag="v${MESHMONITOR_VERSION}"
    TEMPLATE_NAME="meshmonitor-${MESHMONITOR_VERSION}-amd64.tar.gz"
    TEMPLATE_PATH="${TEMPLATE_DIR}/${TEMPLATE_NAME}"
    local url="https://github.com/${GITHUB_REPO}/releases/download/${tag}/${TEMPLATE_NAME}"

    mkdir -p "$TEMPLATE_DIR"
    if [ -f "$TEMPLATE_PATH" ]; then
        log "Template already cached at ${TEMPLATE_PATH}."
    else
        log "Downloading ${url}..."
        wget -O "$TEMPLATE_PATH" "$url"
    fi
}

snapshot_pre_update() {
    if [ "$TAKE_SNAPSHOT" != "1" ]; then
        return 0
    fi
    local snap_name
    snap_name="before_update_v${MESHMONITOR_VERSION//./_}_$(date +%Y%m%d_%H%M%S)"
    log "Creating Proxmox snapshot '${snap_name}' (best-effort)..."
    if ! pct snapshot "$CTID" "$snap_name" >/dev/null 2>&1; then
        warn "Snapshot creation failed (storage may not support snapshots). Continuing with file backups."
    fi
}

backup_existing_container() {
    mkdir -p "$BACKUP_DIR"
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"

    DATA_BACKUP_FILE="${BACKUP_DIR}/meshmonitor-ct${CTID}-data-${stamp}.tar.gz"
    ENV_BACKUP_FILE="${BACKUP_DIR}/meshmonitor-ct${CTID}-env-${stamp}.tar.gz"
    ROOT_HASH_FILE="${BACKUP_DIR}/meshmonitor-ct${CTID}-root-hash-${stamp}.txt"

    local was_running="0"
    if ct_running; then
        was_running="1"
        log "Stopping MeshMonitor services for a clean backup..."
        pct exec "$CTID" -- systemctl stop meshmonitor meshmonitor-apprise 2>/dev/null || true
    else
        log "Starting CT ${CTID} temporarily for backup..."
        pct start "$CTID"
        sleep 6
    fi

    resolve_network_config

    if [ "$RESTORE_DATA" = "1" ]; then
        log "Backing up /data → ${DATA_BACKUP_FILE}"
        pct exec "$CTID" -- tar czf /tmp/meshmonitor-data.tar.gz /data
        pct pull "$CTID" /tmp/meshmonitor-data.tar.gz "$DATA_BACKUP_FILE"
        pct exec "$CTID" -- rm -f /tmp/meshmonitor-data.tar.gz || true
    fi

    if [ "$RESTORE_ENV_FILE" = "1" ]; then
        log "Backing up /etc/meshmonitor → ${ENV_BACKUP_FILE}"
        pct exec "$CTID" -- tar czf /tmp/meshmonitor-env.tar.gz /etc/meshmonitor 2>/dev/null || true
        pct pull "$CTID" /tmp/meshmonitor-env.tar.gz "$ENV_BACKUP_FILE" 2>/dev/null || true
        pct exec "$CTID" -- rm -f /tmp/meshmonitor-env.tar.gz || true
    fi

    if [ "$RESTORE_ROOT_PASSWORD" = "1" ]; then
        log "Saving old root password hash → ${ROOT_HASH_FILE}"
        pct exec "$CTID" -- awk -F: '$1 == "root" { print $2 }' /etc/shadow > "$ROOT_HASH_FILE"
        chmod 600 "$ROOT_HASH_FILE"
    fi

    if [ "$was_running" = "1" ]; then
        # Restart services so the CT is healthy when we read network config.
        pct exec "$CTID" -- systemctl start meshmonitor meshmonitor-apprise 2>/dev/null || true
    fi

    log "Backup complete."
}

prune_old_backups() {
    if [ "$KEEP_BACKUPS_DAYS" = "0" ] || [ -z "$KEEP_BACKUPS_DAYS" ]; then
        return 0
    fi
    if ! [ -d "$BACKUP_DIR" ]; then
        return 0
    fi
    log "Pruning backups in ${BACKUP_DIR} older than ${KEEP_BACKUPS_DAYS} days..."
    # Only prune files this script creates: meshmonitor-ct<CTID>-*.
    find "$BACKUP_DIR" -maxdepth 1 -type f \
        -name "meshmonitor-ct${CTID}-*" \
        -mtime "+${KEEP_BACKUPS_DAYS}" \
        -print -delete || true
}

destroy_and_recreate() {
    log "Stopping CT ${CTID}..."
    pct stop "$CTID" 2>/dev/null || true

    log "Destroying CT ${CTID}..."
    pct destroy "$CTID"

    log "Creating CT ${CTID} from ${TEMPLATE_NAME}..."
    log "  hostname=${HOSTNAME_OVERRIDE} cores=${CORES} memory=${MEMORY} swap=${SWAP}"
    log "  storage=${STORAGE} rootfs=${ROOTFS_SIZE}G bridge=${BRIDGE} net=${EFFECTIVE_IP_CONFIG}"
    log "  unprivileged=${UNPRIVILEGED} onboot=${ONBOOT} features=${CT_FEATURES}"

    pct create "$CTID" "local:vztmpl/${TEMPLATE_NAME}" \
        --hostname "$HOSTNAME_OVERRIDE" \
        --cores "$CORES" \
        --memory "$MEMORY" \
        --swap "$SWAP" \
        --net0 "name=eth0,bridge=${BRIDGE},ip=${EFFECTIVE_IP_CONFIG}" \
        --storage "$STORAGE" \
        --rootfs "${STORAGE}:${ROOTFS_SIZE}" \
        --unprivileged "$UNPRIVILEGED" \
        --features "$CT_FEATURES" \
        --onboot "$ONBOOT"

    pct start "$CTID"
}

restore_data_and_env() {
    if [ "$RESTORE_DATA" = "1" ] && [ -n "${DATA_BACKUP_FILE:-}" ] && [ -f "$DATA_BACKUP_FILE" ]; then
        log "Restoring /data from ${DATA_BACKUP_FILE}..."
        pct push "$CTID" "$DATA_BACKUP_FILE" /tmp/meshmonitor-data.tar.gz
        pct exec "$CTID" -- tar xzf /tmp/meshmonitor-data.tar.gz -C /
        pct exec "$CTID" -- rm -f /tmp/meshmonitor-data.tar.gz
        pct exec "$CTID" -- chown -R meshmonitor:meshmonitor /data || true
    fi

    if [ "$RESTORE_ENV_FILE" = "1" ] && [ -n "${ENV_BACKUP_FILE:-}" ] && [ -f "$ENV_BACKUP_FILE" ]; then
        log "Restoring /etc/meshmonitor from ${ENV_BACKUP_FILE}..."
        pct exec "$CTID" -- mkdir -p /etc/meshmonitor
        pct push "$CTID" "$ENV_BACKUP_FILE" /tmp/meshmonitor-env.tar.gz
        pct exec "$CTID" -- tar xzf /tmp/meshmonitor-env.tar.gz -C /
        pct exec "$CTID" -- rm -f /tmp/meshmonitor-env.tar.gz
        pct exec "$CTID" -- chmod 600 /etc/meshmonitor/meshmonitor.env || true
    fi
}

restore_root_password() {
    if [ "$RESTORE_ROOT_PASSWORD" != "1" ]; then
        return 0
    fi
    if [ -z "${ROOT_HASH_FILE:-}" ] || [ ! -f "$ROOT_HASH_FILE" ]; then
        warn "No root password hash backup found; skipping restore."
        return 0
    fi
    local hash
    hash="$(cat "$ROOT_HASH_FILE")"
    if [ -z "$hash" ] || [ "$hash" = "!" ] || [ "$hash" = "*" ]; then
        warn "Saved root hash is empty/locked; skipping restore."
        return 0
    fi
    log "Restoring old root password hash..."
    pct exec "$CTID" -- usermod -p "$hash" root
    pct exec "$CTID" -- passwd -u root >/dev/null 2>&1 || true
    pct exec "$CTID" -- usermod -s /bin/bash root >/dev/null 2>&1 || true
    warn "Delete ${ROOT_HASH_FILE} once you confirm root login works."
}

install_ssh_optional() {
    if [ "$INSTALL_SSH" != "1" ]; then
        return 0
    fi
    log "Installing openssh-server (root password login enabled)..."
    if pct exec "$CTID" -- test -x /usr/bin/apt-get; then
        pct exec "$CTID" -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update'
        pct exec "$CTID" -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server'
    else
        warn "apt-get not found inside CT; skipping SSH install."
        return 0
    fi

    pct exec "$CTID" -- bash -c "cat > /etc/ssh/sshd_config" <<'SSHD_EOF'
PermitRootLogin yes
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding yes
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
SSHD_EOF

    pct exec "$CTID" -- systemctl daemon-reload
    pct exec "$CTID" -- bash -c 'systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true'
    pct exec "$CTID" -- bash -c 'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true'
}

start_services() {
    log "Starting MeshMonitor services..."
    pct exec "$CTID" -- mkdir -p /data/apprise-config /data/logs /data/system-backups
    pct exec "$CTID" -- chown -R meshmonitor:meshmonitor /data || true
    pct exec "$CTID" -- systemctl daemon-reload
    pct exec "$CTID" -- systemctl enable meshmonitor meshmonitor-apprise
    pct exec "$CTID" -- systemctl restart meshmonitor meshmonitor-apprise
}

show_summary() {
    local ip
    ip="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
    echo
    echo "============================================================"
    echo "MeshMonitor LXC update complete"
    echo "  CTID:       ${CTID}"
    echo "  Version:    ${MESHMONITOR_VERSION}"
    echo "  Hostname:   ${HOSTNAME_OVERRIDE}"
    echo "  Net:        ${EFFECTIVE_IP_CONFIG} (${ip:-pending})"
    echo "  Web UI:     http://${ip:-CONTAINER-IP}:8080"
    echo "  Backups:    ${DATA_BACKUP_FILE:-(none)}"
    echo "              ${ENV_BACKUP_FILE:-(none)}"
    if [ -n "${ROOT_HASH_FILE:-}" ]; then
        echo "  Root hash:  ${ROOT_HASH_FILE} (delete after verifying SSH)"
    fi
    echo "============================================================"
    echo
    echo "Verify with:"
    echo "  pct exec ${CTID} -- systemctl status meshmonitor --no-pager"
    echo "  pct exec ${CTID} -- journalctl -u meshmonitor -n 50 --no-pager"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

[ "$(id -u)" = "0" ] || fail "Run this script as root on the Proxmox host."
[ -n "$CTID" ] || { usage; fail "Missing required --ctid"; }

need_cmd pct
need_cmd wget
need_cmd curl
need_cmd awk
need_cmd sed
need_cmd tar

ct_exists || fail "CT ${CTID} does not exist on this host."

if [ -z "$MESHMONITOR_VERSION" ]; then
    log "Auto-detecting latest MeshMonitor release..."
    MESHMONITOR_VERSION="$(detect_latest_version)"
    log "Latest release: v${MESHMONITOR_VERSION}"
fi

read_ct_resources
[ -n "$STORAGE" ] || fail "Unable to determine target storage. Set STORAGE=<name> or pass it via env."

confirm_destroy
download_template
snapshot_pre_update
backup_existing_container
prune_old_backups
destroy_and_recreate

if ! wait_for_network >/dev/null; then
    warn "Container did not acquire an IP within the timeout; continuing anyway."
fi

restore_data_and_env
restore_root_password
install_ssh_optional
start_services
show_summary
