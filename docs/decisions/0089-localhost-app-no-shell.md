# D-89: A localhost app, no desktop shell

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** H-11 (deviation: no Electron shell even with IT signing). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 11](../reviews/2026-11-20-holistic/11-packaging.md) D-A, §4

## Context
Since macOS 15 an unsigned downloaded bundle takes four clicks into System Settings and gets no auto-update; `git clone` plus a local build is the quarantine-free path. Tauri adds complexity for no gain (the payload is a Node server anyway); Homebrew casks are deprecated for unsigned apps.

## Decision
- The app stays a localhost web app run by two LaunchAgents (web, worker).
- Ease of install comes from a one-line installer and "ask Claude Code to install Command Center", not from an app bundle.
- Tauri, Electron and casks are out.

## Consequences
- No Developer ID or Jamf dependency.
- The UI stays one web app in the user's browser.

## Supersedes
None. Reaffirms D-3 (localhost web app) and closes its "revisit a menubar shell".
