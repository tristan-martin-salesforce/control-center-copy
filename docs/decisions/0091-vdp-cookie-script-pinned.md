# D-91: The installer fetches the VDP cookie script, pinned and hash-checked

- **Status:** Accepted · planned, 2.0 (owner to confirm with the VDP team)
- **Not built as of 2.0;** the Re-auth VDP button and docs/INSTALL.md cover it (23-docs-coherence finding 4).
- **Date:** 2026-11-20
- **Source:** H-13. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 11](../reviews/2026-11-20-holistic/11-packaging.md) D-B

## Context
The VDP sign-in needs `refresh_vdp_fir_cookie.py`, which lives in the VDP app's own repository. Setting it up by hand is the hardest manual install step.

## Decision
- The installer fetches the script from the VDP repository at a pinned commit and checks its hash.
- Tristan confirms licence and ownership with the VDP team first; vendoring a copy is the fallback.

## Consequences
- The VDP doctor check gains a `no_script` state with a Run button.
- A new script version is a deliberate pin bump, never a moving branch.

## Supersedes
None.
