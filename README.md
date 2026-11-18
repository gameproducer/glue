# Peel It Away

This project preserves both implementations of the peeling prototype. Further prototype work in this chat uses the **web app at the repository root**.

## Web prototype

The browser version uses React, TypeScript, and Three.js/WebGL. It includes its own peeling simulation, custom vertex and fragment shaders, cylindrical/conical curl, translucent film, tearing controls, sticker artwork, and behavioral tests.

Requires Node.js 22.13 or newer and pnpm. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the address printed by the development server (normally `http://localhost:3000`).

Verification:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

See [WEB.md](WEB.md) for interaction details.

## Preserved native prototype

`PeelItAway/`, `PeelItAway.xcodeproj/`, and `PeelItAwayTests/` contain the SwiftUI/SpriteKit iPhone/iPad version, shaders, level artwork, and simulation tests. Open the Xcode project to run it. See [NATIVE.md](NATIVE.md).

## Source locations and recovery

This project folder is `/Users/dan/Documents/ChatGPT/Peel It Away`. It was restored on 2026-11-18 from the existing Sites source repository and the native sources under `/Users/dan/Projects`. The originals were left intact.

The prior web folder had incomplete Git metadata, missing app/configuration files, and older application source. The current web app and its Git history were recovered from the existing remote repository. The older local web snapshot is preserved in the recovered Git history and in the ignored `.recovery/local-web-snapshot/` folder.

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for recovery details and verification results, and [AGENTS.md](AGENTS.md) for development preferences.

The primary repository is [gameproducer/glue](https://github.com/gameproducer/glue), configured as the Git remote `origin`. The original Sites source repository remains configured as `sites`. Its live URL is https://peel-material-study.gameproducer.chatgpt.site. Saving source to GitHub does not deploy changes.

Dependency directories, build caches, local secrets, and recovery scratch files are excluded from Git. The lockfile and source assets are included so dependencies and build output can be regenerated.
