PisoTab v0.6.0 — Portable Windows Build Kit

This version switches from the local BAT/NSIS build to a Windows-hosted portable build.

The project is configured to produce:
PisoTab-Portable-0.6.0.exe

The portable EXE bundles:
- Electron dashboard
- Node.js 22.23.2 runtime
- PisoTab local server
- better-sqlite3

The target PC does NOT need Node.js installed.

IMPORTANT:
Use BUILD-ONLINE.txt for the build steps. The GitHub Actions workflow runs on a Windows runner, avoiding the local BAT auto-close problem.
