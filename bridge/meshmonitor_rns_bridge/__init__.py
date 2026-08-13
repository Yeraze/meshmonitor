"""meshmonitor-rns-bridge: a Reticulum sidecar for MeshMonitor (issue #3960).

Ships RNS/LXMF, which carry the non-OSI Reticulum License -- see NOTICE at the
package root. This code is BSD-3 like the rest of MeshMonitor; only the RNS/LXMF
*dependencies* carry the different license. This sidecar is never imported by, or
shipped inside, the main `node:24` MeshMonitor image.
"""

__version__ = "0.1.0"
