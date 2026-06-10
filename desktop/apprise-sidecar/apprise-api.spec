# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the MeshMonitor desktop Apprise sidecar.

Freezes the existing docker/apprise-api.py HTTP wrapper (stdlib http.server +
apprise) into a single self-contained executable so the desktop bundle can ship
full Apprise notification support without a system Python.

Apprise discovers its 100+ notification plugins dynamically at runtime, so a
naive freeze would miss them. `collect_all('apprise')` pulls every submodule,
data file (i18n .mo catalogs, templates) and any bundled binary so every
notification schema works in the frozen build.

Build with:  pyinstaller apprise-api.spec   (run from desktop/apprise-sidecar/)
Output:      dist/apprise-api[.exe]
"""
import os
from PyInstaller.utils.hooks import collect_all

# Spec files don't get __file__; PyInstaller sets SPECPATH to the spec's dir.
ENTRYPOINT = os.path.join(SPECPATH, '..', '..', 'docker', 'apprise-api.py')

apprise_datas, apprise_binaries, apprise_hiddenimports = collect_all('apprise')

a = Analysis(
    [ENTRYPOINT],
    pathex=[],
    binaries=apprise_binaries,
    datas=apprise_datas,
    hiddenimports=apprise_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Optional, heavy transitive deps some apprise plugins pull in but that the
    # desktop sidecar does not need. Excluding them keeps the binary small.
    excludes=['tkinter', 'test', 'unittest', 'pydoc', 'PIL', 'numpy'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='apprise-api',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
