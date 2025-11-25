# MeshMonitor LXC Templates

This directory contains the build system for creating Proxmox LXC container templates for MeshMonitor.

## Overview

The LXC deployment option provides a lightweight alternative to Docker for Proxmox VE users. Templates are automatically built and published to GitHub Releases when new versions are tagged.

## Directory Structure

```
lxc/
├── build-lxc-template.sh          # Main build script (requires root)
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

- Debian/Ubuntu Linux with root access
- `debootstrap` package installed
- Node.js 22 and npm
- At least 2GB free disk space

### Build Process

```bash
# From project root
sudo ./lxc/build-lxc-template.sh 2.19.4
```

This will:
1. Create a minimal Debian 12 (Bookworm) rootfs using debootstrap
2. Install Node.js 22, Python 3, and system dependencies
3. Build the MeshMonitor application (frontend + backend)
4. Copy application files into the container filesystem
5. Install and configure systemd service units
6. Create the meshmonitor user and set permissions
7. Package everything as a `.tar.gz` template

Output: `lxc/build/meshmonitor-2.19.4-amd64.tar.gz`

## Template Contents

The generated template includes:

- **Operating System**: Debian 12 (Bookworm) minimal
- **Runtime**: Node.js 22, Python 3
- **Application**: Pre-built MeshMonitor in `/opt/meshmonitor`
- **Services**: systemd units for meshmonitor and apprise
- **User**: meshmonitor (UID 1000)
- **Data Directory**: `/data` for persistent storage
- **Configuration**: `/etc/meshmonitor/meshmonitor.env`

## Automated Builds

Templates are automatically built via GitHub Actions when version tags are created:

- Workflow: `.github/workflows/lxc-template-build.yml`
- Trigger: `git tag v2.19.4 && git push --tags`
- Output: Published to GitHub Releases

## Deployment

See the [Proxmox LXC Deployment Guide](../docs/deployment/PROXMOX_LXC_GUIDE.md) for detailed installation and configuration instructions.

### Quick Start

1. Download template from [GitHub Releases](https://github.com/jeremiah-k/meshmonitor/releases)
2. Upload to Proxmox: `scp meshmonitor-*.tar.gz root@proxmox:/var/lib/vz/template/cache/`
3. Create LXC container from template via Proxmox web UI
4. Configure `/etc/meshmonitor/meshmonitor.env` with your node IP
5. Access web UI on port 8080

## Testing

Validate template structure before deployment:

```bash
./tests/test-lxc-template.sh lxc/build/meshmonitor-2.19.4-amd64.tar.gz
```

## Limitations

- **No auto-upgrade**: Manual updates required (see deployment guide)
- **Single architecture**: amd64/x86_64 only (ARM support may be added later)
- **Community support**: LXC is best-effort, Docker remains primary method

## Troubleshooting

### Build Failures

**Debootstrap errors**:
- Ensure you're running as root (`sudo`)
- Check internet connectivity
- Verify `/etc/resolv.conf` is configured

**Node.js installation fails**:
- NodeSource repository may be temporarily unavailable
- Check GPG key import succeeded
- Verify Debian version is Bookworm (12)

**Build size issues**:
- Expected template size: 300-500MB
- Ensure sufficient disk space in `/tmp` and build directory

### Template Issues

Use the validation script to diagnose problems:

```bash
./tests/test-lxc-template.sh lxc/build/meshmonitor-*.tar.gz
```

Common issues:
- Missing systemd service files → Re-run build
- Incorrect permissions → Check meshmonitor user creation
- Missing dependencies → Verify debootstrap completed successfully

## Development

To modify the build process:

1. Edit `build-lxc-template.sh` for changes to the build workflow
2. Edit systemd units in `systemd/` for service configuration
3. Test locally before committing:
   ```bash
   sudo ./lxc/build-lxc-template.sh test
   ./tests/test-lxc-template.sh lxc/build/meshmonitor-test-amd64.tar.gz
   ```

## Support

- **Documentation**: [Proxmox LXC Guide](../docs/deployment/PROXMOX_LXC_GUIDE.md)
- **Issues**: [GitHub Issues](https://github.com/jeremiah-k/meshmonitor/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jeremiah-k/meshmonitor/discussions)
