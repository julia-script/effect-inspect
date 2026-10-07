---
'effect-inspect': patch
---

Use Effect 4 as a peer dependency so consumers can choose any compatible 4.x version. Keep Foldkit and the browser platform package as development dependencies for the bundled frontend to avoid imposing Foldkit's exact Effect version on consumers.
