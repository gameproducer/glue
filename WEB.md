# PEEL — browser material study

A WebGL prototype of PEEL for testing the sticker-peeling mechanic across the level packs. See [the core mechanic GDD and TDD](PEEL_GDD_TDD.md) for the current rules, visuals, and design discussion.

## Run

Requires Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Catch an exposed sticker edge or cutout and sweep into the attached material. The curl profile can be switched between cylinder and cone at runtime.

## Architecture

- `lib/peel/PeelSimulation.ts` — deterministic typed-array adhesive grid and connected peel front that advances in local waves.
- `lib/render/PeelRenderer.ts` — Three.js mesh, two-sided procedural artwork, state texture, and GPU curl deformation.
- `app/PeelExperience.tsx` — pointer input, level state, settings, HUD, and failure/success flow.

## Verify

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

## Level packs

Use the level dropdown at the top of the game to choose a sticker, grouped by pack. The adjacent arrows move to the previous or next level. Switching starts a fresh attempt and resets the recording; the selected level and its physics settings are remembered locally. Each level uses the move limit in its pack metadata.

The 190 original levels come from `sticker/_packlist.json` and each pack's `_packinfo.json`. The Octopus prototype is also available. Development, test, and production build scripts run `scripts/prepare-levels.mjs` to validate the catalog and copy listed PNGs to generated `public/stickers/`. Add new levels to the pack metadata and restart development or rebuild.

The original `den` value is retained as catalog metadata; the current web simulation has no matching density parameter, so it is not used to change physics.
