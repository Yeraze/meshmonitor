# meshmonitor-rns-bridge: a Reticulum sidecar, entirely separate from the main
# MeshMonitor `node:24` image. RNS/LXMF carry the non-OSI Reticulum License and must
# NEVER ship in the main image or package.json -- see NOTICE. This is its own image.
#
# python:3.12-alpine is viable per the WP0 spike (RETICULUM_WP0_SPIKE_EVIDENCE.md §2):
# rns's only compiled dependency (cryptography, via cffi) ships musllinux_1_2 wheels,
# so `pip install` resolves entirely from prebuilt wheels on Alpine -- no compiler
# toolchain needed at build time, keeping the image small.
FROM python:3.12-alpine

# Reticulum needs a writable home for its default config/storage state even when a
# configDir is supplied explicitly at runtime (attach mode still touches
# ~/.reticulum-adjacent paths for identity/ratchet caches in some code paths).
ENV HOME=/home/bridge \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN addgroup -S bridge && adduser -S bridge -G bridge -h /home/bridge \
    && mkdir -p /home/bridge && chown -R bridge:bridge /home/bridge

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY meshmonitor_rns_bridge ./meshmonitor_rns_bridge
COPY NOTICE ./NOTICE

USER bridge

# Defaults match config.py; BRIDGE_TOKEN has no default and MUST be supplied.
ENV BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8765 \
    RNS_MODE=attach \
    BRIDGE_LOG_LEVEL=info

EXPOSE 8765

ENTRYPOINT ["python", "-m", "meshmonitor_rns_bridge"]
