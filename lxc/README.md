# MeshMonitor LXC Templates

This directory contains the build system for creating Proxmox LXC container templates for MeshMonitor.

## Overview

The LXC deployment option provides a lightweight alternative to Docker for Proxmox VE users. Templates are automatically built and published to GitHub Releases when new versions are tagged.

## Directory Structure

```
lxc/
├── build-lxc-template.sh          # Main build script (requires root)
├── meshmonitor-update             # In-place updater (installed to /usr/local/bin in the template)
├── sparse-cone.txt                # Sparse-checkout cone list for the git clone (see file for maintenance notes)
├── update.sh                      # Host-side destroy-and-recreate updater (run on Proxmox host)
├── systemd/
│   ├── meshmonitor.service        # Main application systemd unit
│   └── meshmonitor-apprise.service # Apprise notification service unit
├── proxmox/
│   ├── meshmonitor.conf           # Example Proxmox LXC configuration
│   └── post-install.sh            # Post-deployment setup script
├── build/                         # Build output directory (git-ignored)
└── README.md                      # This file
```

## Building Templates

### Prerequisites

- Debian/Ubuntu Linux with root access (VM recommended — debootstrap requires full kernel namespace access)
- `debootstrap`, `git`, `curl` packages installed
- Node.js is **not** required on the build host — the script installs Node.js 24 via NodeSource inside the container rootfs
- At least 2GB free disk space (template output is ~490MB)

### Build Process

```bash
# From the lxc/ directory
sudo bash build-lxc-template.sh 4.12.0

# Or without a version argument to build from main:
sudo bash build-lxc-template.sh
```

This will:
1. Create a minimal Debian 12 (Bookworm) rootfs using debootstrap
2. Install Node.js 24 (via NodeSource), Python 3, sudo, and system dependencies
3. Clone the MeshMonitor repo into the container using a partial+sparse git clone
4. Build the application inside the container chroot (npm install, build, build:server)
5. Install and configure systemd service units
6. Create the meshmonitor user and set permissions
7. Bundle meshmonitor-update in `lxc/` — self-installs to `/usr/local/bin` on first operator run
8. Package everything as a `.tar.gz` template

Output: `lxc/build/meshmonitor-<version>-amd64.tar.gz`

### Sparse Cone

`sparse-cone.txt` controls which top-level directories are materialized inside the
container. See that file for the maintenance obligation — if you add a new top-level
directory that is required at runtime, add it there.

## Template Contents

The generated template includes:

- **Operating System**: Debian 12 (Bookworm) minimal
- **Runtime**: Node.js 24, Python 3
- **Application**: MeshMonitor cloned from git in `/opt/meshmonitor` (git-native from first boot)
- **Services**: systemd units for meshmonitor and apprise
- **User**: meshmonitor (UID 1000)
- **Data Directory**: `/data` for persistent storage
- **Configuration**: `/etc/meshmonitor/meshmonitor.env`
- **Updater**: `meshmonitor-update` at `/usr/local/bin/meshmonitor-update`

## Automated Builds

Templates are automatically built via GitHub Actions when version tags are created:

- Workflow: `.github/workflows/lxc-template-build.yml`
- Trigger: `git tag v<version> && git push --tags`
- Output: Published to GitHub Releases

## Deployment

See the [Proxmox LXC Deployment Guide](../docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed installation and configuration instructions.

### Quick Start

1. Download template from [GitHub Releases](https://github.com/yeraze/meshmonitor/releases)
2. Upload to Proxmox: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
3. Create LXC container from template via Proxmox web UI
4. Configure `/etc/meshmonitor/meshmonitor.env` with your node IP
5. Access web UI on port **3001** (LXC has no port mapping — the app runs directly on 3001)

## Updating an Existing Container

Templates built from this version are git-native from first boot. Two update paths are available:

### In-place update (recommended — no downtime, no data migration)

Run inside the container:

```bash
# First run — self-installs to /usr/local/bin and adds it to PATH:
bash /opt/meshmonitor/lxc/meshmonitor-update

# All subsequent runs — available directly from anywhere:
meshmonitor-update
```

This performs a `git pull`, rebuilds, and restarts services in place. No template redownload needed.

### Full template swap (alternative — use when major OS or dependency changes ship, or on LXCs with limited resources)

`lxc/update.sh` automates the destroy-and-recreate flow on the Proxmox host:

```bash
# Update CT 100 to the latest release (auto-detected from GitHub):
./lxc/update.sh --ctid 100

# Or pin a specific version:
./lxc/update.sh --ctid 100 --version 4.12.0
```

What it does:

1. Reads the existing container's resources (cores, memory, swap, storage, bridge, rootfs size) and IP/gateway.
2. Takes a Proxmox snapshot (best-effort) and writes file backups of `/data` and `/etc/meshmonitor` to `/root/meshmonitor-lxc-backups/`.
3. Downloads the requested release template into `/var/lib/vz/template/cache/`.
4. Destroys the old CT and recreates it with the **same CTID and IP**, then restores `/data` and the env file.
5. Restarts the MeshMonitor services using the canonical systemd units shipped in the template.

Safety:

- Requires explicit confirmation (interactive prompt, or `--yes` / `CONFIRM=YES_DESTROY` for unattended runs).
- SSH root install and root-password restore are **opt-in** (`--install-ssh`, `--restore-root-password`).
- Pass `--no-snapshot` to skip the Proxmox snapshot on storages that don't support snapshots.

See `./lxc/update.sh --help` for the full flag list.

## Limitations

- **Single architecture**: amd64/x86_64 only (ARM support may be added later)
- **Community support**: LXC is best-effort, Docker remains primary method

## Troubleshooting

### Build Failures

**Debootstrap errors**:
- Ensure you're running as root (`sudo`)
- Build inside a VM, not an LXC container — debootstrap requires full kernel namespace access
- Check internet connectivity
- Verify `/etc/resolv.conf` is configured

**Node.js installation fails**:
- NodeSource repository may be temporarily unavailable
- Check GPG key import succeeded
- Verify Debian version is Bookworm (12)

**Build size issues**:
- Expected template size: 450-500MB
- Ensure sufficient disk space in the build directory

### Template Issues

Common issues:
- Missing systemd service files → Re-run build
- Incorrect permissions → Check meshmonitor user creation in Step 9
- Missing dependencies → Verify debootstrap completed successfully

## Development

To modify the build process:

1. Edit `build-lxc-template.sh` for changes to the build workflow
2. Edit `sparse-cone.txt` to add/remove top-level directories from the container clone
3. Edit systemd units in `systemd/` for service configuration
4. Test locally: `sudo bash lxc/build-lxc-template.sh`

## Support

- **Documentation**: [Proxmox LXC Guide](../docs/deployment/PROXMOX_LXC_GUIDE.md)
- **Issues**: [GitHub Issues](https://github.com/yeraze/meshmonitor/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yeraze/meshmonitor/discussions)
