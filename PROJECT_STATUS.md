# Project status — 2026-11-18

## Active implementation

Continue with the web prototype at this repository root. React/TypeScript handles the interface and input, and Three.js/WebGL handles the GPU rendering and shaders. The SwiftUI/SpriteKit project is preserved alongside it for reference.

## Recovery and provenance

- Restored the project folder configured for this chat: `/Users/dan/Documents/ChatGPT/Peel It Away`.
- Recovered the complete current web source and existing Git history from the original Sites source repository, starting at commit `f811e98e5ec0ed34421a1b09bfc2b63113194076`.
- Sites project: `appgprj_6a9a11edfe088191a8116af7e279306b`.
- Source remote: `https://git.chatgpt-team.site/6652b0d0-b8ee-446c-92bb-d5e6928babf6/appgprj_6a9a11edfe088191a8116af7e279306b.git`.
- The previous `/Users/dan/Projects/web` folder had incomplete Git metadata, older app source, and missing route/configuration files. Its surviving files exactly match historical commit `04a151f3b64dcce71d41aa47e485967dab52b440`, which is retained in this repository's history. An additional local snapshot is in ignored `.recovery/local-web-snapshot/`.
- Copied the native source, shaders, level artwork, Xcode project, and tests from `/Users/dan/Projects`. All 291 native files were checked byte-for-byte against the originals.
- Preserved the original native README as `NATIVE.md` and the web README as `WEB.md`; added a root README and the user's development preferences in `AGENTS.md`.
- Original source folders were left intact. Dependencies, build output, per-user state, and scratch recovery copies are excluded from Git.

## Verification

- Locked dependency installation completed successfully.
- Web simulation tests: **9 passed, 0 failed** (`node --experimental-strip-types --test tests/*.test.mjs`, the command behind `pnpm test`).
- TypeScript: **passed** (`node node_modules/typescript/bin/tsc --noEmit --incremental false`).
- Production build: **passed** using the Sites `build-site.mjs` helper, which invokes the project's `vinext build` script.
- The web application's code, dependency inputs, tests, and Sites identity match the recovered remote source. This backup adds native files and project documentation; it does not change gameplay.
- Browser interaction and native Xcode execution were not tested during this source backup.

## Repository and hosting

Save this complete project to the existing Sites source repository. The live site is https://peel-material-study.gameproducer.chatgpt.site. This task saves source and a version only; it does not deploy or change access.

Sites uses short-lived repository credentials. Do not store tokens in the project or Git configuration. Future synchronization can obtain fresh repository access through the Sites tools.
