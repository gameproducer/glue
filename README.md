# PEEL — browser material study

A one-level WebGL prototype of PEEL, built for fast game-design assessment.

## Run

Requires Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Catch any exposed sticker edge or cutout and drag away from the center. The curl profile can be switched between cylinder and cone at runtime.

## Architecture

- `lib/peel/PeelSimulation.ts` — deterministic typed-array adhesive grid and Dijkstra front propagation.
- `lib/render/PeelRenderer.ts` — Three.js mesh, two-sided procedural artwork, state texture, and GPU curl deformation.
- `app/PeelExperience.tsx` — pointer input, level state, settings, HUD, and failure/success flow.

## Verify

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm build
```
