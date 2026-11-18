# Personal Codex efficiency preferences

- Reply in English unless explicitly requested otherwise.
- Do not spawn subagents unless explicitly requested.
- Keep exploration proportional to the task.
- Read only task-relevant documentation and source files.
- Avoid unrelated audits, redundant checks, and unnecessary repeated tool calls.
- Preserve repository instructions, required verification, and release safeguards.

# Project context

- Continue prototype development in the web app at this repository root (React, TypeScript, Three.js/WebGL).
- The SwiftUI/SpriteKit prototype in `PeelItAway/`, its Xcode project, and its tests are preserved for native reference.
- Web simulation: `lib/peel/PeelSimulation.ts`.
- Web rendering and shaders: `lib/render/PeelRenderer.ts`.
- Web input and controls: `app/PeelExperience.tsx`.
- Run `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm build` after relevant code or dependency changes.
- Primary source repository: `https://github.com/gameproducer/glue` (Git remote `origin`, branch `main`). The `sites` remote is retained for Sites synchronization.
- Preserve `.openai/hosting.json` and the existing Sites project identity.
- See `PROJECT_STATUS.md` for recovery context and verification limits.
- Saving source does not authorize changing the live deployment or its audience.
