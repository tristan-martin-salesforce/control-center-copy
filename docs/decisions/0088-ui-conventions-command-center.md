# D-88: UI conventions; the product is named Command Center

- **Status:** Accepted · Tailwind rule built (lint warning); rename planned, 2.0 (chunk p4-rename-command-center) · as of 2.0 (2026-11-21): the rename built by D-101; the Tailwind rule is still a lint warning
- **Date:** 2026-11-20
- **Source:** H-10b (deviation: the name). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 01](../reviews/2026-11-20-holistic/01-ui-audit.md) R10, T5-T7

## Context
Three styling systems and 45 bespoke `*Row` components; re-auth shown as a pasted `python3` line in seven places; the sidebar already says Command Center while everything else says Control Center.

## Decision
- New UI code is Tailwind and the tokens only. CSS modules and global CSS are frozen and migrated when touched (lint warns on a new import).
- Re-auth is a button with a "Show command" disclosure, never a pasted command line.
- The product name is **Command Center**, renamed everywhere, including the package name and the state folder, with a folder migration on update. New user-facing text says Command Center now; existing strings change in one final chunk.

## Consequences
- The state folder moved from `~/Library/Application Support/control-center/` to `command-center/` with the 2.0 update: built in [D-101](0101-rename-command-center.md).

## Supersedes
D-32 (keep the name Control Center).
