# Peel It Away

## Core mechanic GDD and TDD

**Baseline** · Web prototype at `83eced7` · 19 November 2026 · [Play the current build](https://peel-material-study.gameproducer.chatgpt.site)

## Game design

### The player experience

Peel an intact sticker off a board with a finger or cursor. Catch an exposed edge, sweep into the sticker, and watch the material curl back to reveal its underside. The puzzle is choosing where to start, how to steer, and when to put the flap down and take a new grip. The payoff is seeing a stubborn shape come off cleanly.

The shape is the puzzle. Its perimeter, holes, thin connections, and separate pieces determine which grips are available and how a pull travels. A single sweep can solve a simple silhouette. A more awkward silhouette may reward a short peel that creates a better starting point for the next move.

### One attempt

| Beat | What the player sees and does |
| --- | --- |
| Pick up | Press near an outside edge, a cutout, or a previously unglued area. A drag that starts in open space can catch an edge it crosses. |
| Peel | Sweep into the still-glued material. The edge between the lifted and flat sticker advances, and the flap curls. The released percentage includes the material lifted during the current drag. |
| Regrip | Let go after a valid partial lift to bank one move. The flap lies back on the board with a distinct unglued finish. It stays unglued and can be picked up again. A tiny or invalid pull can settle without counting a move. |
| Remove | Free the last glued area of a connected piece, in one move or several. The piece flattens with its backside facing the player and dissolves, even while held. Other pieces remain playable. The completed peel counts when the player lets go. |
| Tear | The held fragment separates and can still be dragged. The remaining material stays on the board. On release, the result explains which limit was crossed and offers a retry. |

**Goal and mastery.** Clear the board with each piece intact. Each level has a target move count. The first move above it shows a brief toast and play continues. A tear fails the attempt. Reset restores the sticker and starts a fresh recording with the current settings.

### How a pull fails

| Signal | Current default | Behavior |
| --- | --- | --- |
| Tension tear | 40% | Load builds from the shape of the peel front, adhesive resistance, reach, and drag speed. Sustained forward pulling near the threshold adds strain. A slight stretch gives the player a short visual warning. |
| Area jump | 15% | A sudden gain in newly unglued area can tear an anchored flap. The gain is measured in a single solver update as a share of the original sticker area. |
| Outward pull | 5% sensitivity | Pulling back on a flap can stall it. Distance and sustained reverse motion add load toward the tension limit. Returning to the forward sweep can recover the peel. Letting go during the reversal can discard the current lift. |
| Thin neck | 5% sensitivity | A constriction between wider sections contributes to tension. The solver estimates the neck and its two shoulders near the current peel front. |
| Grip distance | 84 CSS pixels | The gap is between the pointer and the **moving grip on the flap**. The first 21 CSS pixels are slack, then the contribution rises cubically. Reaching the cap tears a still-attached flap. |

Tension tear and Area jump are adjustable from 0–66%. Outward pull and Thin neck are adjustable from 0–100%. Saved values are per level. Grip distance is a screen-space constant, so its physical size depends on the device and page scale.

### Material and feedback

| Sticker state | Visual language |
| --- | --- |
| Glued | The front shows the artwork, sticker color, and selected front finish. Imported silhouettes start white. |
| Lifted | The fold exposes a translucent back film with its own shader. A newly lifted patch and a previously unglued patch use the same back film. Material beneath the film retains its own surface appearance. |
| Unglued on the board | The default is dimmed. Transparent, Frosted, and Diagonal hatch are selectable. The finish follows that patch across moves. |
| Fully removed | The piece relaxes toward a flat backside pose over about 420 ms, then dissolves over about 1.8 seconds. |
| Torn | A loose fragment follows the pointer and leaves a visible remainder. Tension and Area jump charts, a status hint, and the result card communicate the cause. |

**Visual controls.** Front finish and Back film each offer nine presets. They can be combined with five backgrounds and eleven sticker color choices. Lift transparency is shared by all back films and defaults to 50%. Cylinder and Cone are two ways to render the curl. The bottom control strip and charts can be collapsed on mobile.

**Sound.** Optional generative audio responds to forward peel progress. The presets are Silk peel and Paper crackle for ASMR, Soft chime, Deep bass, and Psychedelic bass. The default is Off. A preview button auditions the current choice. The browser can provide haptics for release and tear when supported.

**Camera.** Manual zoom runs from 60–160%. During a drag, the camera starts to zoom out only when the pointer is within 72 CSS pixels of a screen edge, recent motion heads toward that edge, and the visible moving material needs room. Extra drag reach can fade in near the edge to help finish a long sweep.

### Level design reference

The selector has 190 imported stickers across 27 packs, plus Octopus. The pack metadata supplies each move target.

| Test level | Target | Useful for comparing ideas |
| --- | --- | --- |
| Checkmark | 1 | A simple silhouette and a one-sweep mastery target. |
| Calculator | 2 | Internal contours and the choice of where to grip. |
| Air Element | 3 | Separate strokes, tight curls, and the readability of a translucent backside. |
| Link | 2 | Separate interlocking silhouettes, regrips, and long folds around a curved seam. |
| Barbell | 4 | The transition from a broad lobe through a thin neck into another broad lobe. |

### Questions for the next design discussion

- **Puzzle depth.** What should make a second move feel clever? Try promising a better grip, a safer direction, or a shorter risky section and test which behavior players discover.
- **Mastery.** Does the move target work best as a personal challenge, a scored achievement, or a rule in a dedicated mode? Compare attempts on the same shape.
- **Material identity.** Can a player tell that a sticker is paper, vinyl, or foil by the bend, sound, and effort of the first pull? Decide whether the proposed material changes feedback or asks the player to change technique.
- **Visual direction.** Compare finishes on one fixed gesture. Judge whether the glued area, free underside, and earlier unglued patch are recognizable where they overlap.
- **A proposal to test together.** Name the intended player feeling, the grip or decision that would change, one existing level to try it on, and the visible or measurable result that would make the idea worth keeping.

## Technical design

### From input to pixels

1. **Asset and state.** [StickerAsset.ts](lib/peel/StickerAsset.ts) turns artwork alpha into a binary grid 208 cells wide with height scaled to the image aspect. The solver stores separate values for outside, adhered, released, lifted, and torn. The original artwork alpha defines the fine silhouette in the shader.
2. **Input and solver.** [PeelExperience.tsx](app/PeelExperience.tsx) captures one pointer and translates its movement into sticker coordinates. [PeelSimulation.ts](lib/peel/PeelSimulation.ts) finds an accessible edge, estimates the inward direction, and advances a connected front in local waves using travel, direction, and seeded adhesion. The current gesture keeps a copy of the pre-drag state so an invalid pull can settle and a tear can restore the board remainder.
3. **Progress and failure.** The progress numerator is committed released cells plus newly lifted cells in the current gesture. Area jump compares those newly lifted counts across updates. Tears record a cause, measured value, and threshold. An area jump can use the previous viable flap or a small connected region at the grip. If the fragment includes part of an earlier unglued patch, the connected unglued area goes with it. The level result considers 99.7% release complete as a grid tolerance.
4. **Rendering.** [PeelRenderer.ts](lib/render/PeelRenderer.ts) draws flat, unglued, curled, and torn material with separate texture masks and front/back shading in Three.js/WebGL. [AttachedCurl.ts](lib/render/AttachedCurl.ts) uses distance from the actual attachment to pin the seam and limits how far adjacent points spread along the drag. The lifted flap gets the mesh detail in its active region, and the curl depth is smoothed between cells. The projected grip used for failure checks samples that same curl field.
5. **Framing and feedback.** [PeelFraming.ts](lib/render/PeelFraming.ts) computes edge intent, fit, and extra reach. The browser batches texture and pose updates to animation frames. A change of camera framing alone contributes no drag delta. [PeelAudio.ts](lib/peel/PeelAudio.ts) synthesizes the optional progress sound.

React and TypeScript manage the web prototype. The preserved SwiftUI/SpriteKit project is available as native reference. The active design baseline is the web implementation above.

### Design levers in the code

| Change to try | Start here | What to compare |
| --- | --- | --- |
| New shape or move target | [Pack list](sticker/_packlist.json) and each pack’s `_packinfo.json` | Where a player starts, which grips become available, and how many clean moves they find. |
| Different peel feel or tear behavior | [PeelSimulation.ts](lib/peel/PeelSimulation.ts) and the Physics menu | Same gesture with different settings, including the first failed threshold and the attached remainder. |
| A visual material or new feedback cue | [PeelAppearance.ts](lib/render/PeelAppearance.ts), [PeelRenderer.ts](lib/render/PeelRenderer.ts), and [PeelAudio.ts](lib/peel/PeelAudio.ts) | The same sticker held at several curl angles, settled between moves, and fully removed. |
| New camera or touch behavior | [PeelFraming.ts](lib/render/PeelFraming.ts) and input handling in [PeelExperience.tsx](app/PeelExperience.tsx) | A short central sweep and a long peel toward an edge on a narrow viewport. |

The [level preparation script](scripts/prepare-levels.mjs) validates the pack files and generates the browser catalog and public artwork. The catalog retains the original density metadata for reference. Adhesion in the current solver comes from its seeded grid.

### Verification and known limits

For a design or rendering comparison, keep the level, settings, and drag as similar as possible. Use **Physics → Diagnostic log** to export local JSON. It contains pointer events, solver snapshots, settings, viewport and canvas size, final cell states, and recent frame timings. Pair it with a screenshot or a short clip for issues that show up only in the rendered fold. Level reset starts a fresh log.

The solver and curl are game approximations. Narrow or oblique pulls can still expose small facets in the backside or stretch the print locally. When a flap looks split, compare the screenshot with the logged tear state before adjusting a threshold. Test interactions on both a wide screen and a narrow viewport when changing edge reach, grip distance, or transparency.

Run `pnpm dev` to try the browser build. The verification commands are `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm build`. The repository setup is in [README.md](README.md).
