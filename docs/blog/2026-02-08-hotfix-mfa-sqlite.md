---
id: news-2026-02-08-hotfix-mfa-sqlite
title: 'MeshMonitor v3.4.9 - Hotfix: MFA on SQLite'
date: '2026-02-08T22:00:00Z'
category: bugfix
priority: important
minVersion: 3.4.9
---
MeshMonitor v3.4.9 is a hotfix release addressing two bugs:

- **MFA on SQLite** (#1828) - Two-factor authentication setup, enable, disable, and backup code operations failed on SQLite (the default database) with "Auth repository not initialized". MFA now works correctly on all database backends.
- **News popup dismiss** (#1827) - The news popup dismiss checkbox was not persisting correctly.
