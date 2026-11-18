# Peel It Away — assessment prototype

This repository contains a focused Swift/SpriteKit rewrite of the original Cocos2d-x peeling prototype. It intentionally targets one polished, replayable level before menus, progression, or bulk asset migration.

## Prototype goals

- Direction-sensitive, deterministic peel-front propagation.
- Persistent released material and rollback of accidental micro-pulls.
- Tension buildup and deterministic tearing when a front stalls.
- Full-color sticker art independent from its physical alpha mask.
- Interactive cylindrical and conical curl projections.
- Stable adaptive camera framing during a pull.
- A compact model that avoids one heap object per simulated pixel.
- In-scene frame-rate and simulation-time instrumentation.

## Run

1. Install Xcode with the iOS 17 SDK or newer.
2. Open `PeelItAway.xcodeproj`.
3. Select the `PeelItAway` scheme and an iPhone or iPad simulator.
4. Run with **⌘R**. Run deterministic model tests with **⌘U**.

No external packages are required. PNG images in `PeelItAway/Levels`, including nested subfolders, are copied into the app bundle. Add images there and rebuild to include them. The procedural assessment sticker remains available.

## Interaction

- Touch a visible outside edge or the edge of an existing released area.
- Pull away from the sticker. Pull direction changes release resistance.
- Release after meaningful progress to spend one move.
- `CURL` switches between cylindrical and conical deformation.
- `DEBUG` shows the active peel front and grab point.
- `RESET` rebuilds the current level.
- Tap **Levels** to browse PNG thumbnails grouped by folder, or search by filename or folder name. Tap a PNG to immediately start it as a fresh level. Your choice is remembered across launches. Choose **Assessment sticker** to return to the procedural level.
- PNG transparency defines the peelable shape, including holes. Images retain their aspect ratio.

## Architecture

- `PeelItAway/Model`: Framework-independent deterministic simulation.
- `PeelItAway/Rendering`: Procedural assessment art, mutable masks, shaders, and curl geometry.
- `PeelItAway/Scene`: Input, camera, level flow, and performance HUD.
- `PeelItAway/UI`: Minimal assessment controls.
- `PeelItAwayTests`: Behavioral tests for rollback, propagation, accessibility, holes, and determinism.

The 192×192 simulation grid is independent of the 1024×1024 artwork. Mask uploads are coalesced, and curl geometry can update without rebuilding mask data when attachment state is unchanged.

## First-device validation checklist

The current environment does not have Xcode installed, so the first run should verify:

1. Mask row orientation matches the artwork. If vertically flipped, invert the source row in `MaskTexture.update`.
2. Front/back shader compilation succeeds on SpriteKit's Metal renderer.
3. The curl grid does not show triangle inversion at extreme cone settings.
4. An outward pull releases smoothly while a strongly sideways pull builds tension.
5. Instruments shows no mutable-texture update backlog during continuous dragging.

The project deliberately keeps the renderer behind `StickerNode`; if SpriteKit mutable textures or grid warping miss the visual/performance bar, that class can be replaced by a small Metal-backed renderer without rewriting gameplay.

