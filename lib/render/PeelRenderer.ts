import * as THREE from "three";
import {
  BACKGROUNDS, CARAMEL_FINISH, CLEAR_TAPE_FINISH, FILM_FILTERS, PUFFY_FINISH, SECURITY_HOLOGRAM_FINISH,
  shadowVisible, STICKER_COLORS, usesFrontRefraction, usesTranslucentCoating, type PeelAppearance,
} from "./PeelAppearance";
import {
  curlBounds, DEFAULT_CAMERA_SETTINGS, dragScaleForReach, fitFrustum, MAX_TENSION_STRETCH,
  regionBounds, stepCamera, translateBounds, unionBounds,
  type CameraMotion, type CameraSettings, type PeelBounds, type PeelRegion,
} from "./PeelFraming";
import { AttachedCurl } from "./AttachedCurl";
import { nearestStateSources, extendStateTexture, writeCurlDistances } from "./StateTexture";
import { FrameTimings } from "./FrameTimings";
import { GlassDepthScene } from "./GlassDepthScene";
import { puffyNormals } from "./PuffyFinish";
import { FilmOptics } from "./FilmOptics";
import { CREASE_START_RISK, GESTURE_START_RISK, TearWarningOverlay } from "./TearWarningOverlay";
import { detachedAlignmentDuration, detachedAnimation, releaseSettleDuration, writeReleaseSurface } from "./ReleaseSurface";
import { Cell, type CurlProfile, type PeelSimulation, type PeelSnapshot, type Vec2 } from "../peel/PeelSimulation";
import { stickerLayout, type StickerArea, type StickerPiece } from "../peel/StickerLayout";
import { moveManualView, type ManualView, type TouchCameraMode, type TouchCameraView } from "./TouchCamera";
import { stampCrease } from "./SavedCreases";

const STICKER_WIDTH = 4.8;
const DISSOLVE_MS = 1800;
const TORN_LAYER_Z = 0.086;
const RIDGE_HEIGHT = 0.065;
const GRIP_CURL_HEIGHT = 0.105;
const curlRadius = (profile: CurlProfile) => profile === "cone" ? 0.28 : 0.32;
const tensionStretch = (stress: number, threshold: number) => threshold > 0
  ? MAX_TENSION_STRETCH * THREE.MathUtils.smoothstep(stress / threshold, 0.9, 1) : 0;

type DissolvingShape = {
  texture: THREE.DataTexture;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  detachedAt: number;
  releasedAt: number | null;
  alignmentMs: number;
  fadeStart: number | null;
  origin: Vec2;
  offset: Vec2;
  bounds: PeelBounds | null;
};

type StickerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
type SettlingFlap = {
  meshes: StickerMesh[];
  state: THREE.DataTexture;
  curl: THREE.DataTexture;
  from: PeelBounds;
  to: PeelBounds;
  started: number | null;
  duration: number;
  progress: number;
};

type DragInput = {
  screen: Vec2;
  start: Vec2;
  point: Vec2;
  cameraStart: THREE.Vector3;
  unitsPerPixel: number;
  working: boolean;
  assist: { direction: Vec2; gain: number } | null;
};

type PeelUniforms = {
  uArt: { value: THREE.Texture };
  uPuff: { value: THREE.Texture };
  uScene: { value: THREE.Texture };
  uViewport: { value: THREE.Vector2 };
  uFilmOptics: { value: number };
  uOpticsTint: { value: THREE.Color };
  uMaterialTime: { value: number };
  uWhiteArtwork: { value: number };
  uStickerColor: { value: THREE.Color };
  uFaceFinish: { value: number };
  uBackFinish: { value: number };
  uReleaseFinish: { value: number };
  uState: { value: THREE.DataTexture };
  uAttachedCurl: { value: THREE.DataTexture };
  uReleaseHistory: { value: THREE.DataTexture };
  uReleaseTexel: { value: THREE.Vector2 };
  uRidgeHeight: { value: number };
  uGripCurlHeight: { value: number };
  uSettlingMask: { value: THREE.DataTexture };
  uHideSettling: { value: number };
  uRestState: { value: THREE.DataTexture };
  uLayer: { value: number };
  uFilmColor: { value: THREE.Color };
  uLiftedOpacity: { value: number };
  uGrab: { value: THREE.Vector2 };
  uDirection: { value: THREE.Vector2 };
  uFrontDepth: { value: number };
  uRadius: { value: number };
  uCone: { value: number };
  uStretch: { value: number };
  uStickerSize: { value: THREE.Vector2 };
  uUvWindow: { value: THREE.Vector4 };
  uRelax: { value: number };
  uFlatOffset: { value: THREE.Vector2 };
  uDissolve: { value: number };
  uTornOffset: { value: THREE.Vector2 };
  uTearStrain: { value: THREE.Vector3 };
  uSavedCreases: { value: THREE.DataTexture };
  uKeepCrease: { value: number };
  uCaramelTint: { value: THREE.Color };
};

const vertexShader = /* glsl */ `
  precision highp float;
  uniform vec2 uGrab;
  uniform vec2 uDirection;
  uniform float uFrontDepth;
  uniform float uRadius;
  uniform float uCone;
  uniform float uLayer;
  uniform float uStretch;
  uniform vec2 uStickerSize;
  uniform vec4 uUvWindow;
  uniform sampler2D uAttachedCurl;
  uniform sampler2D uReleaseHistory;
  uniform sampler2D uRestState;
  uniform float uRidgeHeight;
  uniform float uGripCurlHeight;
  uniform float uRelax;
  uniform vec2 uFlatOffset;
  uniform vec2 uTornOffset;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;
  varying vec2 vLensCenter;
  varying float vLensRadius;

  const float PI = 3.141592653589793;

  void main() {
    vUv = uUvWindow.xy + uv * uUvWindow.zw;
    vec2 sheetPosition = (vUv - 0.5) * uStickerSize;
    vec3 p = vec3(sheetPosition, position.z);
    vec2 direction = normalize(uDirection);
    vec2 lateralAxis = vec2(-direction.y, direction.x);
    vec2 relative = p.xy - uGrab;
    float along = dot(relative, direction);
    float lateral = dot(relative, lateralAxis);
    float q = max(uFrontDepth - along, 0.0);
    float theta = 0.0;

    if (uLayer > 2.5) {
      p.xy += uTornOffset;
      p.z += 0.08;
    } else if (uLayer > 1.5) {
      #ifndef PEEL_DETACHED
        // The depth field pins the actual seam and limits stretch along it.
        float correction = texture2D(uAttachedCurl, vUv).r;
        q = max(0.0, q - correction);
      #endif
      float arcLength = q * (1.0 + uStretch);
      float coneScale = mix(1.0, clamp(1.0 + lateral * 0.24, 0.58, 1.46), uCone);
      float radius = max(0.12, uRadius * coneScale);
      theta = min(arcLength / radius, PI);
      float extra = max(arcLength - PI * radius, 0.0);
      p.xy += direction * (q + extra - radius * sin(theta));
      p.z = 0.018 + radius * (1.0 - cos(theta));
    } else if (uLayer > 0.5) {
      vec2 relief = texture2D(uReleaseHistory, vUv).gb;
      p.z += 0.018 + dot(relief, vec2(uRidgeHeight, uGripCurlHeight));
    }
    vCurl = smoothstep(0.0, PI, theta);
    #ifdef PEEL_SETTLING
      vec2 relief = texture2D(uReleaseHistory, vUv).gb;
      float restingLift = smoothstep(0.02, 0.98, texture2D(uRestState, vUv).g);
      float restHeight = (0.018 + dot(relief, vec2(uRidgeHeight, uGripCurlHeight))) * restingLift;
      p = mix(p, vec3(sheetPosition, restHeight), uRelax);
      theta *= 1.0 - uRelax;
      vCurl *= 1.0 - uRelax;
    #endif
    #ifdef PEEL_DETACHED
      // Open around the grip with the same handedness as the folded-over flap.
      vec2 flatPosition = sheetPosition - 2.0 * along * direction + uFlatOffset;
      p = mix(p, vec3(flatPosition, 0.022), uRelax);
      theta = mix(theta, PI, uRelax);
      vCurl *= 1.0 - uRelax;
    #endif
    vNormalWorld = vec3(direction * sin(theta), cos(theta));
    vec3 lens = vec3(uGrab + direction * uFrontDepth, 0.02 + uRadius);
    if (uLayer > 2.5) lens.xy += uTornOffset;
    #ifdef PEEL_SETTLING
      lens = mix(lens, vec3(uGrab, 0.022), uRelax);
    #endif
    #ifdef PEEL_DETACHED
      lens = mix(lens, vec3(uGrab + uFlatOffset, 0.022), uRelax);
    #endif
    vec4 center = projectionMatrix * modelViewMatrix * vec4(lens, 1.0);
    vec4 rim = projectionMatrix * modelViewMatrix * vec4(lens + vec3(uRadius * 2.4, 0.0, 0.0), 1.0);
    vLensCenter = center.xy / center.w * 0.5 + 0.5;
    vLensRadius = max(0.04, abs(rim.x / rim.w - center.x / center.w) * 0.5);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uArt;
  uniform sampler2D uPuff;
  uniform sampler2D uScene;
  uniform vec2 uViewport;
  uniform float uFilmOptics;
  uniform vec3 uOpticsTint;
  uniform float uMaterialTime;
  uniform float uWhiteArtwork;
  uniform vec3 uStickerColor;
  uniform float uFaceFinish;
  uniform float uBackFinish;
  uniform float uReleaseFinish;
  uniform sampler2D uState;
  uniform sampler2D uReleaseHistory;
  uniform vec2 uReleaseTexel;
  uniform sampler2D uSettlingMask;
  uniform float uHideSettling;
  uniform float uRidgeHeight;
  uniform float uGripCurlHeight;
  uniform float uRelax;
  uniform float uLayer;
  uniform vec3 uFilmColor;
  uniform float uLiftedOpacity;
  uniform float uDissolve;
  uniform sampler2D uAttachedCurl;
  uniform vec2 uGrab;
  uniform vec2 uDirection;
  uniform float uFrontDepth;
  uniform vec2 uStickerSize;
  uniform vec3 uTearStrain;
  uniform sampler2D uSavedCreases;
  uniform float uKeepCrease;
  uniform vec3 uCaramelTint;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;
  varying vec2 vLensCenter;
  varying float vLensRadius;

  float grain(vec2 position) {
    return fract(sin(dot(position, vec2(12.9898, 78.233))) * 43758.5453);
  }

  float softNoise(vec2 position) {
    vec2 cell = floor(position);
    vec2 t = smoothstep(vec2(0.0), vec2(1.0), fract(position));
    float low = mix(grain(cell), grain(cell + vec2(1.0, 0.0)), t.x);
    float high = mix(grain(cell + vec2(0.0, 1.0)), grain(cell + vec2(1.0, 1.0)), t.x);
    return mix(low, high, t.y);
  }

  vec3 spectrum(float phase) {
    return 0.5 + 0.5 * cos(phase + vec3(0.0, 2.094, 4.189));
  }

  float contourLine(float phase, float width) {
    float bandDistance = abs(fract(phase + 0.5) - 0.5);
    float pixelWidth = fwidth(phase);
    return (1.0 - smoothstep(width, width + max(0.005, pixelWidth), bandDistance))
      * (1.0 - smoothstep(0.25, 0.6, pixelWidth));
  }

  vec3 translucentCoating(vec3 normal, vec3 light, bool caramel) {
    vec2 sheet = (vUv - 0.5) * uStickerSize / max(uStickerSize.x, uStickerSize.y);
    vec4 coating = texture2D(uPuff, vUv);
    vec3 profile = normalize(coating.rgb * 2.0 - 1.0);
    float bevel = caramel ? 0.80 : 0.16;
    vec3 curved = normalize(normal + vec3(profile.xy * bevel, 0.0));
    vec2 screen = gl_FragCoord.xy / uViewport;
    vec2 pixel = 0.5 / uViewport;
    vec2 shift = curved.xy * (caramel ? 0.062 : 0.018) * vec2(uViewport.y / uViewport.x, 1.0);
    vec3 background = texture2D(uScene, clamp(screen - shift, pixel, 1.0 - pixel)).rgb;
    float grazing = 1.0 - abs(curved.z);
    float edge = caramel ? 1.0 - profile.z : 1.0 - smoothstep(0.27, 0.60, coating.a);
    vec3 reflection = reflect(vec3(0.0, 0.0, -1.0), curved);
    float panel = (dot(sheet, vec2(0.55, 0.83)) + reflection.x * 0.45 - 0.13) / (caramel ? 0.14 : 0.095);
    float highlight = exp(-panel * panel) * (0.16 + grazing * 0.56 + edge * 0.5);
    float shine = pow(max(dot(reflect(-light, curved), vec3(0.0, 0.0, 1.0)), 0.0), caramel ? 21.0 : 48.0);
    if (caramel) {
      vec3 candy = sqrt(uCaramelTint) * (0.36 + max(dot(curved, light), 0.0) * 0.48);
      vec3 absorption = mix(vec3(0.42), clamp(uCaramelTint, 0.0, 1.0), 0.68);
      vec3 body = background * mix(vec3(1.0), absorption, 0.66 + edge * 0.24);
      return mix(body, candy, 0.41 + edge * 0.25) + vec3(1.0, 0.91, 0.75) * (highlight * 0.7 + shine * 0.38);
    }
    return background * 0.98 + vec3(0.89, 0.95, 1.0) * (0.013 + edge * 0.46 + grazing * 0.22 + highlight + shine * 0.22);
  }

  void main() {
    vec4 state = texture2D(uState, vUv);
    float layerMask = uLayer < 0.5
      ? state.r
      : (uLayer < 1.5 ? state.g : (uLayer < 2.5 ? state.b : state.a));
    float layerCoverage = smoothstep(0.02, 0.98, layerMask);
    if (uLayer < 0.5) {
      // Keep the surface opaque beneath the curl's feathered edge so the
      // background cannot show through where the two layers meet.
      float foldOverlap = step(0.02, state.r) * step(0.02, state.b);
      layerCoverage = max(layerCoverage, foldOverlap);
    }
    if (uLayer < 1.5 && uHideSettling > 0.5) {
      layerCoverage *= 1.0 - smoothstep(0.02, 0.98, texture2D(uSettlingMask, vUv).b);
    }
    if (layerCoverage < 0.01) discard;
    float silhouette = texture2D(uArt, vUv).a;
    if (silhouette <= 0.0) discard;

    bool flatReleased = uLayer > 0.5 && uLayer < 1.5;
    // Three.js reverses WebGL winding for BackSide materials, so
    // gl_FrontFacing does not identify the sticker's physical side.
    #ifdef PEEL_BACK_FACE
      vec3 normal = normalize(-vNormalWorld);
    #else
      vec3 normal = normalize(vNormalWorld);
      if (flatReleased && uRidgeHeight + uGripCurlHeight > 0.0) {
        // Shade from the height texture to avoid a faceted seam across mesh triangles.
        vec2 texel = uReleaseTexel * 2.0;
        vec2 height = vec2(uRidgeHeight, uGripCurlHeight);
        vec2 x = vec2(texel.x, 0.0);
        vec2 y = vec2(0.0, texel.y);
        vec2 slope = vec2(
          dot(texture2D(uReleaseHistory, vUv + x).gb - texture2D(uReleaseHistory, vUv - x).gb, height),
          dot(texture2D(uReleaseHistory, vUv + y).gb - texture2D(uReleaseHistory, vUv - y).gb, height)
        ) / (2.0 * texel * uStickerSize);
        normal = normalize(vec3(-slope, 1.0));
      }
    #endif
    #ifdef PEEL_DETACHED
      if (normal.z < 0.0) normal = -normal;
    #endif

    vec2 strainLight = vec2(0.0);
    float strain = uTearStrain.z;
    #ifdef PEEL_SETTLING
      strain *= 1.0 - uRelax;
    #endif
    if (strain > 0.0 && uLayer > 1.5 && uLayer < 2.5) {
      // Relight the attached material around the actual curl root. The existing
      // layer mask and artwork alpha carry the fold around holes and cutouts.
      vec2 sheet = (vUv - 0.5) * uStickerSize;
      vec2 fromStrain = sheet - uTearStrain.xy;
      vec2 side = vec2(-uDirection.y, uDirection.x);
      float span = mix(0.20, 0.31, strain);
      float taper = 1.0 - smoothstep(0.055, span, abs(dot(fromStrain, side)));
      taper *= 1.0 - smoothstep(0.12, 0.33, abs(dot(fromStrain, uDirection)));
      float nominal = uFrontDepth - dot(sheet - uGrab, uDirection);
      float curlDepth = max(0.0, nominal - texture2D(uAttachedCurl, vUv).r);
      float fold = curlDepth / mix(0.14, 0.090, strain);
      strainLight = vec2(
        smoothstep(0.04, 0.30, fold) * (1.0 - smoothstep(0.46, 0.84, fold)),
        smoothstep(0.36, 0.72, fold) * (1.0 - smoothstep(0.88, 1.47, fold))
      ) * taper * strain;
      vec3 tangent = vec3(uDirection * normal.z, -dot(normal.xy, uDirection));
      normal = normalize(normal + tangent * (strainLight.x - strainLight.y) * 0.24);
    }
    vec3 lightDirection = normalize(vec3(-0.38, 0.55, 0.74));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float grazing = pow(1.0 - abs(normal.z), 2.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
    bool caramel = uFaceFinish == ${CARAMEL_FINISH}.0;
    bool translucent = uFaceFinish == ${CLEAR_TAPE_FINISH}.0 || caramel;
    #ifdef PEEL_BACK_FACE
    vec3 filmColor = uFilmColor * (0.78 + diffuse * 0.14);
    filmColor += vec3(1.0, 0.82, 0.92) * (grazing * 0.18 + specular * 0.24);
    if (uBackFinish > 7.5) {
      vec2 tile = vUv * 31.0;
      vec2 bead = fract(tile) - vec2(0.36, 0.57);
      bead.x -= (grain(floor(tile)) - 0.5) * 0.22;
      float rim = 1.0 - smoothstep(0.018, 0.07, abs(length(bead) - 0.19));
      float glint = 1.0 - smoothstep(0.015, 0.09, length(bead - vec2(-0.09, 0.1)));
      filmColor = mix(vec3(0.34, 0.52, 0.61), vec3(0.86, 0.99, 1.0), rim * 0.4 + glint * 0.55);
    } else if (uBackFinish > 6.5) {
      float radius = length((vUv - vec2(0.55, 0.43)) * vec2(1.1, 1.0));
      float ripple = contourLine(radius * 27.0 + 0.2 * sin(vUv.y * 18.0), 0.09);
      filmColor = mix(vec3(0.16, 0.49, 0.59), vec3(0.66, 0.96, 0.91), ripple);
    } else if (uBackFinish > 5.5) {
      float ribs = contourLine(vUv.x * 44.0 + vUv.y * 7.0, 0.12);
      float flip = smoothstep(-0.28, 0.32, normal.x + 0.18 * sin(vUv.y * 9.0));
      filmColor = mix(vec3(0.12, 0.73, 0.84), vec3(0.76, 0.24, 0.83), flip);
      filmColor = mix(filmColor, vec3(0.80, 0.92, 1.0), ribs * 0.58);
    } else if (uBackFinish > 4.5) {
      float swirl = sin(vUv.x * 12.0 + sin(vUv.y * 8.0));
      vec3 thinFilm = spectrum(4.0 * grazing + 3.0 * swirl + vUv.y * 6.0);
      filmColor = mix(vec3(0.79, 0.90, 0.94), thinFilm, 0.42 + grazing * 0.45);
    } else if (uBackFinish > 3.5) {
      float flow = 0.5 + 0.5 * sin(vUv.y * 17.0 + 3.0 * sin(vUv.x * 8.0));
      filmColor = mix(vec3(0.51, 0.19, 0.055), vec3(1.0, 0.72, 0.30), flow);
    } else if (uBackFinish > 2.5) {
      vec2 grid = abs(fract(vUv * 56.0) - 0.5);
      float thread = 1.0 - smoothstep(0.06, 0.19, min(grid.x, grid.y));
      filmColor = mix(filmColor, vec3(0.68, 0.94, 0.9), thread * 0.75);
    } else if (uBackFinish > 1.5) {
      vec3 prism = spectrum((vUv.x - vUv.y * 0.63) * 13.0 + vCurl * 5.0);
      filmColor = mix(filmColor, prism, 0.73);
    } else if (uBackFinish > 0.5) {
      float speckle = grain(floor(vUv * 430.0));
      filmColor = vec3(0.57, 0.72, 0.83) + vec3(speckle * 0.17 + grazing * 0.12);
    }
    vec3 color = filmColor;
    float alpha = silhouette * uLiftedOpacity;
    if (uFilmOptics > 0.5) {
      vec2 screen = gl_FragCoord.xy / uViewport;
      vec2 aspect = vec2(uViewport.x / uViewport.y, 1.0);
      vec2 delta = (screen - vLensCenter) * aspect;
      float radius = vLensRadius * aspect.x;
      float falloff = exp(-dot(delta, delta) / (radius * radius));
      vec2 warped = screen;
      vec2 dispersion = vec2(0.0);
      if (uFilmOptics > 3.5) {
        vec2 facet = fract(vUv * vec2(18.0, 16.0)) - 0.5;
        warped += facet * vec2(0.028, 0.018) + normal.xy * 0.025;
        dispersion = normalize(vec2(0.7, 0.3) + normal.xy) * 0.009;
      } else if (uFilmOptics > 2.5) {
        float twist = falloff * 2.2 + sin(vUv.y * 18.0 + vCurl * 5.0) * 0.35;
        mat2 rotation = mat2(cos(twist), -sin(twist), sin(twist), cos(twist));
        warped = vLensCenter + (rotation * delta) / (aspect * (1.0 + falloff * 0.45));
        warped += vec2(sin(vUv.y * 31.0), cos(vUv.x * 27.0)) * 0.012;
        dispersion = vec2(cos(twist), sin(twist)) * 0.014;
      } else if (uFilmOptics > 1.5) {
        warped += vec2(sin(vUv.y * 38.0 + vCurl * 4.0), sin(vUv.x * 32.0 - vCurl * 3.0)) * 0.019;
        warped += normal.xy * 0.018;
      } else {
        warped = vLensCenter + delta / (aspect * (1.0 + falloff * 1.25));
        warped += normal.xy * 0.018;
      }
      // Clamp each dispersed ray separately at the drawing-buffer boundary.
      vec2 edge = 0.5 / uViewport;
      vec3 refracted = vec3(
        texture2D(uScene, clamp(warped + dispersion, edge, 1.0 - edge)).r,
        texture2D(uScene, clamp(warped, edge, 1.0 - edge)).g,
        texture2D(uScene, clamp(warped - dispersion, edge, 1.0 - edge)).b
      );
      color = mix(refracted * uOpticsTint, filmColor, uLiftedOpacity) + specular * 0.08;
      alpha = silhouette;
    }
    if (translucent) {
      color = translucentCoating(normal, lightDirection, caramel);
      alpha = silhouette;
    }
    #else
    vec3 artworkColor = mix(texture2D(uArt, vUv).rgb, uStickerColor, uWhiteArtwork);
    vec3 printedColor = artworkColor * (0.61 + diffuse * 0.43);
    printedColor += vec3(0.48, 0.40, 0.56) * grazing * 0.15 + specular * 0.22;
    if (translucent) {
      printedColor = translucentCoating(normal, lightDirection, caramel);
    } else if (uFaceFinish == ${SECURITY_HOLOGRAM_FINISH}.0) {
      vec2 sheet = (vUv - 0.5) * uStickerSize / max(uStickerSize.x, uStickerSize.y);
      float angle = dot(normal.xy, vec2(3.7, -2.15));
      float position = dot(sheet, vec2(6.2, 1.9)) + angle;
      vec3 foil = spectrum(position + 1.9);
      vec2 lattice = vec2(sheet.x * 21.0 + sheet.y * 10.0, sheet.y * 22.0);
      float chevrons = contourLine(lattice.x + abs(fract(lattice.y) - 0.5) * 1.65, 0.10);
      float ghost = contourLine(lattice.x * 1.5 - lattice.y * 0.21 + angle * 0.25, 0.035);
      vec3 base = mix(foil * (0.46 + diffuse * 0.34), artworkColor, 0.18);
      printedColor = base * (0.92 + chevrons * 0.16 + ghost * 0.08)
        + spectrum(position - 1.4) * (chevrons * 0.15 + grazing * 0.25) + specular * 0.38;
    } else if (uFaceFinish > 18.5) {
      vec3 coating = normalize(texture2D(uPuff, vUv).rgb * 2.0 - 1.0);
      vec2 axis = normalize(uDirection);
      vec2 side = vec2(-axis.y, axis.x);
      // Carry the coating's local normals through the same rotation as the curl.
      vec3 tangent = vec3(axis * normal.z, -dot(normal.xy, axis));
      vec3 puffNormal = normalize(tangent * dot(coating.xy, axis)
        + vec3(side, 0.0) * dot(coating.xy, side) + normal * coating.z);
      float puffLight = max(dot(puffNormal, lightDirection), 0.0);
      float rim = pow(1.0 - max(puffNormal.z, 0.0), 3.0);
      if (uFaceFinish > 19.5) {
        vec2 screen = gl_FragCoord.xy / uViewport;
        vec2 aspect = vec2(uViewport.y / uViewport.x, 1.0);
        vec2 sheet = (vUv - 0.5) * uStickerSize / max(uStickerSize.x, uStickerSize.y);
        vec2 flow = vec2(
          sin(sheet.y * 20.0 + sheet.x * 7.0 + uMaterialTime * 1.35),
          cos(sheet.x * 17.0 - sheet.y * 9.0 - uMaterialTime * 1.1)
        );
        float bend = 0.038;
        float coatingStrength = 0.10;
        float shimmer = 0.0;
        if (uFaceFinish > 22.5) {
          // Water has fine, crossing waves and a narrow moving caustic.
          float ripple = cos(dot(sheet, vec2(29.0, 35.0)) - uMaterialTime * 2.4 + flow.x * 1.8);
          puffNormal = normalize(puffNormal + vec3(flow * 0.12, 0.0));
          bend = 0.018;
          coatingStrength = 0.13;
          shimmer = pow(max(0.0, ripple), 12.0) * 0.24;
        } else if (uFaceFinish > 21.5) {
          // Liquid glass bends longer light streaks around broad moving lobes.
          puffNormal = normalize(puffNormal + vec3(flow * 0.23, 0.0));
          coatingStrength = 0.19;
          bend = 0.066;
        } else if (uFaceFinish < 20.5) {
          // Jelly holds a saturated core and blooms softly around the bevel.
          coatingStrength = 0.57;
          bend = 0.054;
          shimmer = puffLight * 0.10;
        }
        vec2 ray = screen - puffNormal.xy * bend * aspect;
        vec2 edge = 0.5 / uViewport;
        vec3 transmitted = texture2D(uScene, clamp(ray, edge, 1.0 - edge)).rgb;
        vec3 reflection = reflect(vec3(0.0, 0.0, -1.0), puffNormal);
        float stripWidth = uFaceFinish < 20.5 ? 0.20 : 0.07;
        float strip = exp(-pow((reflection.x + 0.38) / stripWidth, 2.0) - pow((reflection.y - 0.36) / 0.62, 4.0));
        float panel = dot(sheet, vec2(0.58, 0.81)) + reflection.x * 0.32 + 0.11;
        float sweep = exp(-pow(panel / (uFaceFinish < 20.5 ? 0.14 : 0.061), 2.0));
        vec3 tint = artworkColor * (0.38 + puffLight * 0.46);
        if (uFaceFinish > 22.5) tint = mix(tint, vec3(0.16, 0.57, 0.78), 0.62);
        printedColor = mix(transmitted, tint, coatingStrength);
        printedColor += vec3(0.88, 0.95, 1.0) * (strip * 0.69 + sweep * 0.16 + rim * 0.38 + shimmer);
      } else {
        vec3 reflection = reflect(vec3(0.0, 0.0, -1.0), puffNormal);
        // Two studio strip lights create long, white reflections around the dome.
        float strip = exp(-pow((reflection.x + 0.38) / 0.095, 2.0)
          - pow((reflection.y - 0.42) / 0.68, 4.0));
        float softbox = exp(-pow((reflection.x + 0.31) / 0.32, 2.0)
          - pow((reflection.y - 0.52) / 0.65, 2.0));
        float secondary = exp(-pow((reflection.x - 0.60) / 0.065, 2.0)
          - pow((reflection.y + 0.18) / 0.42, 4.0));
        printedColor = artworkColor * (0.52 + puffLight * 0.52);
        printedColor += artworkColor * softbox * 0.16 + vec3(1.0, 0.88, 0.67) * rim * 0.10;
        printedColor = mix(printedColor, vec3(1.0, 0.985, 0.94), clamp(strip * 0.94 + secondary * 0.56, 0.0, 0.97));
      }
    } else if (uFaceFinish > 13.5) {
      vec2 sheet = (vUv - 0.5) * uStickerSize / max(uStickerSize.x, uStickerSize.y);
      // A reflected light panel moves across the coating as the sheet curls.
      vec2 reflected = sheet + reflect(vec3(0.0, 0.0, -1.0), normal).xy * 0.56;
      float panel = dot(reflected, vec2(0.50, 0.866)) + 0.10;
      float panelEnd = 1.0 - smoothstep(0.29, 0.58, abs(dot(reflected, vec2(0.866, -0.50))));
      float gloss = (1.0 - smoothstep(0.044, 0.106, abs(panel))) * panelEnd;
      vec3 coatedArt = artworkColor * (0.64 + diffuse * 0.31);

      if (uFaceFinish > 17.5) {
        float incidence = 1.0 - abs(normal.z);
        float phase = panel * 5.3 + incidence * 6.0;
        vec3 sheen = mix(vec3(0.88, 0.94, 1.0), spectrum(phase), 0.54);
        float luster = 1.0 - smoothstep(0.02, 0.33, abs(panel));
        printedColor = mix(coatedArt, sheen, 0.12 + luster * 0.36 + incidence * 0.16);
        printedColor = mix(printedColor, vec3(1.0), gloss * 0.20 + specular * 0.12);
      } else if (uFaceFinish > 16.5) {
        vec2 stamp = fract(sheet * 4.8) - 0.5;
        float curve = length(stamp) + 0.17 * abs(stamp.x * stamp.y) * 8.0;
        float edgeWidth = max(fwidth(curve), 0.004);
        float varnish = 1.0 - smoothstep(0.053, 0.053 + edgeWidth, abs(curve - 0.28));
        float broadGlint = 1.0 - smoothstep(0.02, 0.32, abs(panel));
        float shine = 0.12 + gloss * 0.36 + broadGlint * 0.21 + specular * 0.17;
        printedColor = mix(coatedArt * 0.86, vec3(0.98, 0.99, 1.0), varnish * shine);
      } else if (uFaceFinish > 15.5) {
        vec2 weave = vec2(sheet.x + sheet.y * 0.14, sheet.y - sheet.x * 0.14) * 144.0;
        float warp = contourLine(weave.x + 0.22 * cos(weave.y * 3.142), 0.13);
        float weft = contourLine(weave.y + 0.22 * cos(weave.x * 3.142), 0.18);
        float thread = max(warp * (0.48 + normal.x * 0.23), weft * (0.35 + normal.y * 0.19));
        printedColor = mix(coatedArt * 0.80, vec3(0.94, 0.93, 0.89), thread * 0.38 + gloss * 0.10);
      } else if (uFaceFinish > 14.5) {
        vec2 grainUv = sheet * 420.0;
        float fineGrain = (grain(floor(grainUv)) - 0.5)
          * (1.0 - smoothstep(0.4, 1.4, max(fwidth(grainUv.x), fwidth(grainUv.y))));
        float velvet = (1.0 - smoothstep(0.02, 0.46, abs(panel))) * 0.09 + grazing * 0.14;
        printedColor = artworkColor * (0.65 + diffuse * 0.18 + fineGrain * 0.07)
          + vec3(0.91, 0.87, 0.84) * velvet;
      } else {
        float bounce = 1.0 - smoothstep(0.04, 0.20, abs(panel - 0.17));
        printedColor = mix(coatedArt, vec3(0.97, 0.985, 1.0), gloss * 0.74 + bounce * 0.14 + specular * 0.10);
      }
    } else if (uFaceFinish > 8.5) {
      vec2 sheet = vUv * uStickerSize / max(uStickerSize.x, uStickerSize.y);
      vec3 reflection = reflect(-lightDirection, normal);
      vec3 foilColor;
      if (uFaceFinish > 12.5) {
        // Adjacent lenticular tiles reflect two different color ranges.
        vec2 tile = vec2(sheet.x - sheet.y, sheet.x + sheet.y) * 19.0;
        vec2 local = fract(tile);
        float parity = mod(floor(tile.x) + floor(tile.y), 2.0);
        float stripe = contourLine(tile.x * 5.0, 0.10);
        float angle = normal.x + normal.y * 0.45 + (local.x - 0.5) * 0.52;
        float flip = smoothstep(-0.21, 0.39, angle);
        vec3 cool = mix(vec3(0.12, 0.24, 0.69), vec3(0.22, 0.93, 0.96), flip);
        vec3 warm = mix(vec3(0.91, 0.27, 0.59), vec3(1.0, 0.72, 0.32), 1.0 - flip);
        foilColor = mix(cool, warm, parity) + stripe * 0.17;
      } else if (uFaceFinish > 11.5) {
        // Warp a triangular grid into irregular facets with independent highlights.
        vec2 tile = sheet * 19.0 + vec2(sheet.y * 6.0, 0.0);
        tile += 0.42 * vec2(softNoise(sheet * 22.0), softNoise(sheet.yx * 20.0 + 7.0));
        vec2 local = fract(tile);
        float halfTile = step(local.x, local.y);
        float facet = grain(floor(tile) + halfTile * vec2(0.23, 0.61));
        float flash = 0.5 + 0.5 * cos(facet * 19.0 + reflection.x * 4.0 - reflection.y * 2.5);
        float edge = min(abs(local.x - local.y), min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y)));
        float bevel = 1.0 - smoothstep(0.02, 0.10, edge);
        foilColor = mix(vec3(0.19, 0.32, 0.50), vec3(0.82, 0.95, 1.0), flash) + bevel * 0.14;
      } else if (uFaceFinish > 10.5) {
        float flow = softNoise(sheet * 4.0) + 0.36 * softNoise(sheet * 9.0 + 13.0);
        float phase = flow * 17.0 + reflection.x * 4.0 - reflection.y * 2.0;
        vec3 interference = spectrum(phase);
        float rim = contourLine(phase / 6.283, 0.065);
        foilColor = vec3(0.13, 0.11, 0.19) + interference * (0.53 + grazing * 0.25) + rim * 0.18;
      } else if (uFaceFinish > 9.5) {
        vec2 tile = sheet * 13.0;
        tile.x += mod(floor(tile.y), 2.0) * 0.5;
        vec2 local = fract(tile) - 0.5;
        float rings = contourLine(length(local) * 13.0, 0.085);
        float sweep = 0.5 + 0.5 * cos(dot(local, vec2(9.0, 3.0)) + reflection.x * 5.0);
        foilColor = mix(vec3(0.35, 0.40, 0.49), vec3(0.84, 0.91, 0.97), sweep) + rings * 0.17;
      } else {
        vec2 tool = sheet * 22.0;
        float dent = softNoise(tool);
        vec2 slope = vec2(softNoise(tool + vec2(0.36, 0.0)), softNoise(tool + vec2(0.0, 0.36))) - dent;
        vec3 hammeredNormal = normalize(normal + vec3(slope * 1.8, 0.0));
        float glint = pow(max(dot(reflect(-lightDirection, hammeredNormal), vec3(0.0, 0.0, 1.0)), 0.0), 9.0);
        foilColor = mix(vec3(0.38, 0.17, 0.06), vec3(0.92, 0.63, 0.24), 0.22 + dent * 0.65)
          + vec3(1.0, 0.87, 0.51) * glint * 0.42;
      }
      printedColor = mix(printedColor, foilColor * mix(vec3(1.0), artworkColor, 0.35), 0.82);
    } else if (uFaceFinish > 7.5) {
      vec2 tile = vUv * 86.0;
      float flake = step(0.68, grain(floor(tile)));
      float dotMask = flake * (1.0 - smoothstep(0.07, 0.31, length(fract(tile) - 0.5)));
      printedColor = printedColor * (0.75 + 0.22 * diffuse) + dotMask * vec3(0.70, 0.73, 0.76);
    } else if (uFaceFinish > 6.5) {
      float foil = (vUv.x * 1.45 - vUv.y * 0.75) * 31.0 + normal.x * 9.0 + vCurl * 4.0;
      float stripe = contourLine(foil / 6.283, 0.035);
      vec3 diffraction = spectrum(foil);
      printedColor = mix(printedColor * 0.65, diffraction, 0.52) + vec3(stripe * 0.28);
    } else if (uFaceFinish > 5.5) {
      vec2 printUv = vec2(vUv.x - vUv.y, vUv.x + vUv.y) * 28.0;
      float dotSize = 0.24 + 0.08 * sin((vUv.x + 0.8 * vUv.y) * 5.0) + 0.06 * grazing;
      float ink = 1.0 - smoothstep(dotSize - 0.045, dotSize + 0.065, length(fract(printUv) - 0.5));
      printedColor = mix(printedColor, artworkColor * 0.19 + vec3(0.07, 0.05, 0.14), ink * 0.88);
    } else if (uFaceFinish > 4.5) {
      float vein = sin(vUv.x * 19.0 + vUv.y * 10.0 + 4.0 * sin(vUv.y * 9.0 - vUv.x * 4.0));
      float ink = 1.0 - smoothstep(0.06, 0.65, abs(vein));
      printedColor = mix(printedColor, artworkColor * 0.21 + vec3(0.11, 0.19, 0.29), ink * 0.84);
    } else if (uFaceFinish > 3.5) {
      vec2 hill = vUv - vec2(0.35, 0.58);
      float elevation = length(hill * vec2(1.1, 0.8)) * 21.0 + 0.55 * sin(vUv.x * 14.0 + vUv.y * 12.0);
      float line = contourLine(elevation, 0.07);
      printedColor = mix(printedColor * 0.88, artworkColor * 0.26 + vec3(0.07, 0.18, 0.19), line * 0.92);
    } else if (uFaceFinish > 2.5) {
      float brush = grain(vec2(floor(vUv.y * 520.0), 1.0));
      float highlight = pow(max(0.0, cos((vUv.x + vUv.y * 0.52 + normal.x * 0.2) * 9.0)), 9.0);
      printedColor = printedColor * (0.73 + brush * 0.28) + vec3(0.65, 0.78, 0.92) * highlight * 0.35;
    } else if (uFaceFinish > 1.5) {
      vec3 pearl = spectrum(dot(vUv, vec2(6.0, 4.0)) + vCurl * 5.0);
      printedColor = mix(printedColor * 0.83, pearl * 0.73 + artworkColor * 0.23, 0.48);
    } else if (uFaceFinish > 0.5) {
      float band = (vUv.x + vUv.y * 0.7 + normal.x * 0.35 - 0.82) * 3.6;
      float satin = exp(-band * band);
      printedColor = printedColor * 0.85 + artworkColor * satin * 0.26;
    }
    vec3 color = printedColor;
    float alpha = silhouette;

    // The flat released layer already gets its coverage from state.g. Applying
    // the history mask again there weakens the finish at the feathered edge.
    // The back film has its own appearance, independent of release history.
    float released = flatReleased ? 1.0
      : smoothstep(0.02, 0.98, texture2D(uReleaseHistory, vUv).r);
    #ifdef PEEL_SETTLING
      released *= uRelax;
    #endif
    if (released > 0.0) {
      vec3 releaseColor = vec3(0.21, 0.18, 0.23);
      float releaseAlpha = min(alpha, 0.70 * silhouette);
      if (uReleaseFinish > 4.5) {
        releaseColor = color;
        releaseAlpha = alpha;
        if (uRidgeHeight > 0.0) {
          float bevel = texture2D(uReleaseHistory, vUv).g;
          releaseColor *= mix(0.68, 0.96, bevel);
        }
      } else if (uReleaseFinish > 2.5) {
        float stripe = 0.5 + 0.5 * sin((vUv.x + vUv.y) * 260.0);
        releaseColor = mix(vec3(0.16, 0.14, 0.20), vec3(0.57, 0.50, 0.65), smoothstep(0.55, 0.86, stripe));
      } else if (uReleaseFinish > 1.5) {
        float frost = softNoise(vUv * 45.0) * 0.13 + grain(floor(vUv * 360.0)) * 0.07;
        releaseColor = vec3(0.40, 0.49, 0.57) + frost;
        releaseAlpha = min(alpha, 0.64 * silhouette);
      } else if (uReleaseFinish > 0.5) {
        releaseColor = color;
        releaseAlpha = alpha * 0.30;
      }
      if (flatReleased && uRidgeHeight + uGripCurlHeight > 0.0) {
        float slope = length(normal.xy);
        float reliefLight = dot(normal.xy, normalize(vec2(-0.38, 0.55)));
        releaseColor = releaseColor * (1.0 + reliefLight * 0.46)
          + vec3(0.77, 0.70, 0.84) * (slope * 0.08 + max(0.0, reliefLight) * 0.25);
        releaseAlpha = max(releaseAlpha, silhouette * min(0.72, slope));
      }
      color = mix(color, releaseColor, released);
      alpha = mix(alpha, releaseAlpha, released);
    }
    #endif
    if (uKeepCrease > 0.5) {
      strainLight = max(strainLight, texture2D(uSavedCreases, vUv).rg * 0.92);
    }
    // A soft studio reflection and its falloff leave the material's finish visible.
    color *= 1.0 + strainLight.x * 0.18 - strainLight.y * 0.26;
    color += vec3(strainLight.x * (0.14 + specular * 0.18));
    if (uDissolve > 0.0) {
      float sweep = 0.5 + dot(vUv - 0.5, uDirection) * 0.6;
      float variation = softNoise(vUv * 7.0) * 0.8 + softNoise(vUv * 21.0) * 0.2;
      float dissolveStart = 0.10 + sweep * 0.42 + variation * 0.15;
      float veil = 1.0 - smoothstep(0.0, 1.0, uDissolve) * 0.35;
      alpha *= veil * (1.0 - smoothstep(dissolveStart, dissolveStart + 0.34, uDissolve));
    }
    #if defined(PEEL_SETTLING) && defined(PEEL_BACK_FACE)
      alpha *= 1.0 - smoothstep(0.78, 1.0, uRelax);
    #endif
    gl_FragColor = vec4(color, alpha * layerCoverage);
  }
`;

function makeArtTexture(image: HTMLImageElement) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function makeSurfaceTexture() {
  const size = 768;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(380, 360, 0, 380, 360, 600);
  gradient.addColorStop(0, "#302d35");
  gradient.addColorStop(0.62, "#1b1a20");
  gradient.addColorStop(1, "#111116");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  let random = 91513;
  for (let i = 0; i < 9000; i++) {
    random = Math.imul(random ^ (random >>> 15), 2246822519);
    const x = (random >>> 0) % size;
    random = Math.imul(random ^ (random >>> 13), 3266489917);
    const y = (random >>> 0) % size;
    const alpha = 0.015 + ((random >>> 8) & 31) / 1700;
    context.fillStyle = `rgba(255,245,234,${alpha})`;
    context.fillRect(x, y, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1.6);
  return texture;
}

function makeShadowTexture(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const size = 1024;
  const padding = 58;
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const temporary = document.createElement("canvas");
  temporary.width = temporary.height = size;
  const tempContext = temporary.getContext("2d")!;
  tempContext.drawImage(image, padding, padding, size - padding * 2, size - padding * 2);
  tempContext.globalCompositeOperation = "source-in";
  tempContext.fillStyle = "black";
  tempContext.fillRect(0, 0, size, size);
  context.filter = "blur(22px)";
  context.drawImage(temporary, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

export class PeelRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly frameTimings = new FrameTimings();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(31, 1, 0.1, 40);
  private readonly tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  private readonly raycaster = new THREE.Raycaster();
  private readonly hitPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly stateData: Uint8Array;
  private readonly stateSources: Int32Array;
  private readonly stateTexture: THREE.DataTexture;
  private readonly curlDistances: Uint8Array;
  private readonly curlQueue: Int32Array;
  private curlSeamCount = 0;
  private readonly warningOverlay: TearWarningOverlay;
  private warningGesture: NonNullable<ReturnType<PeelSimulation["tearWarning"]>> | null = null;
  private readonly tearStrain = new THREE.Vector3();
  private readonly attachedCurl: AttachedCurl;
  private readonly curlTexture: THREE.DataTexture;
  private curlPreparedFor: CurlProfile | null = null;
  private readonly releaseHistory: Uint8Array;
  private readonly releaseData: Uint8Array;
  private readonly releaseTexture: THREE.DataTexture;
  private readonly creasePixels: Uint8Array;
  private readonly creaseTexture: THREE.DataTexture;
  private keepCrease = false;
  private lastCrease: { x: number; y: number; strength: number } | null = null;
  private lastReleaseRevision = -1;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly stickerMeshes: StickerMesh[] = [];
  private readonly dissolves: DissolvingShape[] = [];
  private heldDissolve: DissolvingShape | null = null;
  private settling: SettlingFlap | null = null;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly resizeObserver: ResizeObserver;
  private readonly originalWhiteArtwork: boolean;
  private puffTexture: THREE.DataTexture | null = null;
  private filmOptics: FilmOptics | null = null;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private opticsMode = 0;
  private frontFinish = 0;
  private reliefHeight = 0;
  private settingsOpen = false;
  private settingsPreviewDirty = false;
  private readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private readonly plainSurfaceMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
  private readonly surface: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>;
  private glassDepth: GlassDepthScene | null = null;
  private castShadow = false;
  private zoom: number;
  private cameraSettings: CameraSettings;
  private cameraMotion: CameraMotion | null = null;
  private lastCameraTime = performance.now();
  private viewportWidth = 1;
  private viewportHeight = 1;
  private dragInput: DragInput | null = null;
  private readonly stickerBounds: PeelBounds;
  private readonly stickerLayout: ReturnType<typeof stickerLayout>;
  private readonly touchBounds: PeelBounds;
  private touchCameraMode: TouchCameraMode | null;
  private touchPointPending = false;
  private focusedPiece: StickerPiece | null = null;
  private followCurl = false;
  private gluedBounds: PeelBounds | null = null;
  private manualView: ManualView;
  private miniMap: { canvas: HTMLCanvasElement; outline: HTMLElement } | null = null;
  private movingRegion: PeelRegion | null = null;
  private movingBounds: PeelBounds | null = null;
  private readonly stickerWidth = STICKER_WIDTH;
  private readonly stickerHeight: number;
  private frame = 0;
  private resizeFrame = 0;
  // Keep render resolution stable. Reallocating the WebGL drawing buffer mid-gesture
  // caused intermittent single-frame flashes on devices near the FPS thresholds.
  private readonly pixelRatio = Math.min(window.devicePixelRatio, 1.75);
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly simulation: PeelSimulation,
    private readonly artwork: HTMLImageElement,
    artworkAspect: number,
    whiteArtwork = false,
    cameraSettings = DEFAULT_CAMERA_SETTINGS,
    zoom = 1,
    touchCameraMode: TouchCameraMode | null = null,
    private readonly onTouchViewChange?: (view: TouchCameraView) => void,
  ) {
    this.originalWhiteArtwork = whiteArtwork;
    this.stickerHeight = this.stickerWidth / artworkAspect;
    this.stickerBounds = regionBounds({ x: 0, y: 0, width: this.stickerWidth, height: this.stickerHeight }, 0.022);
    this.stickerLayout = stickerLayout(simulation.state, simulation.width, simulation.height);
    this.touchBounds = this.worldBounds(this.stickerLayout.area);
    this.touchCameraMode = touchCameraMode;
    this.manualView = { center: this.boundsCenter(this.touchBounds), zoom: 1 };
    this.cameraSettings = cameraSettings;
    this.zoom = zoom;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.domElement = this.renderer.domElement;
    this.domElement.className = "peel-canvas";
    this.host.appendChild(this.domElement);
    this.warningOverlay = new TearWarningOverlay(host);

    this.surfaceMaterial = new THREE.MeshStandardMaterial({ map: makeSurfaceTexture(), roughness: 0.88, metalness: 0.04 });
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(22, 18), this.surfaceMaterial);
    this.surface.position.z = -0.095;
    this.scene.add(this.surface);
    this.scene.add(new THREE.HemisphereLight(0xa799bd, 0x17141b, 1.2));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.55);
    key.position.set(-3.5, 4.5, 7);
    this.scene.add(key);

    this.stateData = new Uint8Array(simulation.width * simulation.height * 4);
    this.stateSources = nearestStateSources(simulation.state, simulation.width, simulation.height);
    simulation.writeTexture(this.stateData);
    extendStateTexture(this.stateData, this.stateSources);
    this.stateTexture = new THREE.DataTexture(this.stateData, simulation.width, simulation.height, THREE.RGBAFormat);
    // The channels identify layers, while interpolation supplies sub-cell coverage
    // so diagonal release fronts do not expose the simulation grid as stair steps.
    this.stateTexture.minFilter = THREE.LinearFilter;
    this.stateTexture.magFilter = THREE.LinearFilter;
    this.stateTexture.needsUpdate = true;

    this.curlDistances = new Uint8Array(simulation.width * simulation.height);
    this.curlQueue = new Int32Array(this.curlDistances.length);
    this.attachedCurl = new AttachedCurl(simulation.width, simulation.height, this.stickerWidth, this.stickerHeight, this.stateSources);
    this.curlTexture = new THREE.DataTexture(this.attachedCurl.pixels, simulation.width, simulation.height, THREE.RedFormat, THREE.HalfFloatType);
    this.curlTexture.minFilter = THREE.LinearFilter;
    this.curlTexture.magFilter = THREE.LinearFilter;
    this.curlTexture.needsUpdate = true;

    this.releaseHistory = new Uint8Array(simulation.width * simulation.height);
    this.releaseData = new Uint8Array(this.releaseHistory.length * 4);
    this.releaseTexture = new THREE.DataTexture(this.releaseData, simulation.width, simulation.height, THREE.RGBAFormat);
    this.releaseTexture.minFilter = THREE.LinearFilter;
    this.releaseTexture.magFilter = THREE.LinearFilter;
    this.updateReleaseHistory();
    this.creasePixels = new Uint8Array(simulation.width * simulation.height * 2);
    this.creaseTexture = new THREE.DataTexture(this.creasePixels, simulation.width, simulation.height, THREE.RGFormat);
    this.creaseTexture.minFilter = this.creaseTexture.magFilter = THREE.LinearFilter;
    this.creaseTexture.needsUpdate = true;

    const art = makeArtTexture(artwork);
    const geometry = new THREE.PlaneGeometry(this.stickerWidth, this.stickerHeight, 124, 100);
    const layerPasses = [
      { layer: 0, side: THREE.FrontSide, depthWrite: true, renderOrder: 0 },
      { layer: 1, side: THREE.FrontSide, depthWrite: false, renderOrder: 1 },
      { layer: 2, side: THREE.FrontSide, depthWrite: true, renderOrder: 2 },
      { layer: 3, side: THREE.FrontSide, depthWrite: true, renderOrder: 3 },
      { layer: 2, side: THREE.BackSide, depthWrite: false, renderOrder: 4 },
      { layer: 3, side: THREE.BackSide, depthWrite: false, renderOrder: 5 },
    ] as const;
    for (const pass of layerPasses) {
      const uniforms: PeelUniforms = {
        uArt: { value: art },
        uPuff: { value: art },
        uScene: { value: art },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uFilmOptics: { value: 0 },
        uOpticsTint: { value: new THREE.Color(0xffffff) },
        uMaterialTime: { value: 0 },
        uWhiteArtwork: { value: whiteArtwork ? 1 : 0 },
        uStickerColor: { value: new THREE.Color(0xffffff) },
        uFaceFinish: { value: 0 },
        uBackFinish: { value: 0 },
        uReleaseFinish: { value: 0 },
        uState: { value: this.stateTexture },
        uAttachedCurl: { value: this.curlTexture },
        uReleaseHistory: { value: this.releaseTexture },
        uReleaseTexel: { value: new THREE.Vector2(1 / simulation.width, 1 / simulation.height) },
        uRidgeHeight: { value: 0 },
        uGripCurlHeight: { value: 0 },
        uRestState: { value: this.stateTexture },
        uSettlingMask: { value: this.stateTexture },
        uHideSettling: { value: 0 },
        uLayer: { value: pass.layer },
        uFilmColor: { value: new THREE.Color(0xf05fa8) },
        uLiftedOpacity: { value: 0.5 },
        uGrab: { value: new THREE.Vector2(-2.1, 0) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uFrontDepth: { value: 0 },
        uRadius: { value: 0.31 },
        uCone: { value: 0 },
        uStretch: { value: 0 },
        uStickerSize: { value: new THREE.Vector2(this.stickerWidth, this.stickerHeight) },
        uUvWindow: { value: new THREE.Vector4(0, 0, 1, 1) },
        uRelax: { value: 0 },
        uFlatOffset: { value: new THREE.Vector2() },
        uDissolve: { value: 0 },
        uTornOffset: { value: new THREE.Vector2() },
        uTearStrain: { value: this.tearStrain },
        uSavedCreases: { value: this.creaseTexture },
        uKeepCrease: { value: 0 },
        uCaramelTint: { value: new THREE.Color("#e99b50") },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        defines: pass.side === THREE.BackSide ? { PEEL_BACK_FACE: 1 } : {},
        transparent: true,
        side: pass.side,
        depthWrite: pass.depthWrite,
        depthTest: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = pass.renderOrder;
      mesh.position.z = pass.layer * 0.002;
      this.materials.push(material);
      this.stickerMeshes.push(mesh);
      this.scene.add(mesh);
    }

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(this.stickerWidth * 1.14, this.stickerHeight * 1.14),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uShadow: { value: makeShadowTexture(artwork) },
          uState: { value: this.stateTexture },
          uOpacity: { value: 0.38 },
          uPadding: { value: 58 / 1024 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uShadow;
          uniform sampler2D uState;
          uniform float uOpacity;
          uniform float uPadding;
          varying vec2 vUv;
          void main() {
            vec2 artworkUv = (vUv - uPadding) / (1.0 - 2.0 * uPadding);
            vec4 state = texture2D(uState, artworkUv);
            float present = clamp(dot(state, vec4(1.0)), 0.0, 1.0);
            gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(uShadow, vUv).a * present * uOpacity);
          }
        `,
      }),
    );
    this.shadow.position.set(0.06, -0.08, -0.055);
    this.shadow.renderOrder = -1;
    this.scene.add(this.shadow);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.resize();
      });
    });
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  updateState() {
    this.curlPreparedFor = null;
    this.simulation.writeTexture(this.stateData);
    this.curlSeamCount = this.updateMovingRegion() === Cell.lifted
      ? writeCurlDistances(this.stateData, this.curlDistances, this.simulation.width, this.curlQueue) : 0;
    extendStateTexture(this.stateData, this.stateSources);
    this.stateTexture.needsUpdate = true;
    this.updateReleaseHistory();
  }

  private prepareAttachedCurl(grab: Vec2, direction: Vec2, depth: number, profile: CurlProfile) {
    if (this.curlPreparedFor === profile) return;
    this.attachedCurl.update(this.stateData, this.curlDistances, grab, direction, depth, curlRadius(profile), profile === "cone");
    this.curlTexture.needsUpdate = true;
    this.curlPreparedFor = profile;
  }

  private updateMovingRegion() {
    const { width, height, state } = this.simulation;
    let left = width, right = -1, bottom = height, top = -1;
    let layer: number = Cell.outside;
    for (let index = 0; index < state.length; index++) {
      const cell = state[index];
      if (cell !== Cell.lifted && cell !== Cell.torn) continue;
      layer = cell;
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
    }
    if (right < 0) {
      this.movingRegion = null;
      return layer;
    }
    // Include the neighboring texels and mesh triangles along the feathered edge.
    const padX = 2 / width + 1 / 124;
    const padY = 2 / height + 1 / 100;
    const minX = Math.max(0, left / width - padX);
    const maxX = Math.min(1, (right + 1) / width + padX);
    const minY = Math.max(0, bottom / height - padY);
    const maxY = Math.min(1, (top + 1) / height + padY);
    this.movingRegion = {
      x: ((minX + maxX) / 2 - 0.5) * this.stickerWidth,
      y: ((minY + maxY) / 2 - 0.5) * this.stickerHeight,
      width: (maxX - minX) * this.stickerWidth,
      height: (maxY - minY) * this.stickerHeight,
    };
    return layer;
  }

  private updateReleaseHistory() {
    const revision = this.simulation.releaseHistoryRevision;
    if (revision === this.lastReleaseRevision) return;
    this.simulation.writeReleaseHistory(this.releaseHistory);
    writeReleaseSurface(this.releaseData, this.releaseHistory, this.stateSources, this.simulation.width,
      this.simulation.releasedGrips);
    this.releaseTexture.needsUpdate = true;
    this.lastReleaseRevision = revision;
  }

  setPeel(
    grab: Vec2,
    direction: Vec2,
    depth: number,
    profile: CurlProfile,
    stress: number,
    tearThreshold: number,
    tornOffset: Vec2 = { x: 0, y: 0 },
    torn = false,
    detachedPointer?: Vec2,
  ) {
    const worldGrab = this.uvToWorld(grab);
    const worldDirection = new THREE.Vector2(direction.x, direction.y).normalize();
    const worldDepth = depth * this.stickerHeight;
    const radius = curlRadius(profile);
    const stretch = tensionStretch(stress, tearThreshold);
    const offsetX = tornOffset.x * this.stickerWidth;
    const offsetY = tornOffset.y * this.stickerHeight;
    this.movingBounds = null;
    const region = this.movingRegion;
    if (torn && region) {
      this.movingBounds = translateBounds(regionBounds(region, TORN_LAYER_Z), { x: offsetX, y: offsetY });
    } else if (region && worldDepth > 0) {
      if (!detachedPointer) this.prepareAttachedCurl(worldGrab, worldDirection, worldDepth, profile);
      const closeCrop = this.touchCameraMode === "focus" && this.followCurl && !detachedPointer;
      this.movingBounds = (closeCrop ? this.attachedCurl.projectedBounds(worldDirection, stretch) : null)
        ?? curlBounds(region, worldGrab, worldDirection, worldDepth, radius, profile === "cone", stretch);
    }
    for (const material of this.materials) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uGrab.value.copy(worldGrab);
      uniforms.uDirection.value.copy(worldDirection);
      uniforms.uFrontDepth.value = worldDepth;
      uniforms.uRadius.value = radius;
      uniforms.uCone.value = profile === "cone" ? 1 : 0;
      uniforms.uStretch.value = stretch;
      uniforms.uTornOffset.value.set(offsetX, offsetY);
      if (uniforms.uLayer.value === 2 && region && !torn && !detachedPointer) {
        // Spend the curl mesh's subdivisions on the visible flap.
        uniforms.uUvWindow.value.set(
          0.5 + (region.x - region.width / 2) / this.stickerWidth,
          0.5 + (region.y - region.height / 2) / this.stickerHeight,
          region.width / this.stickerWidth,
          region.height / this.stickerHeight,
        );
      } else {
        uniforms.uUvWindow.value.set(0, 0, 1, 1);
      }
    }
    if (detachedPointer) {
      this.moveDissolve(detachedPointer);
      this.movingBounds = null;
    } else {
      this.heldDissolve = null;
    }
    const lift = Math.min(1, depth * 2.2);
    this.shadow.scale.set(1 + lift * 0.08, 1 + lift * 0.12, 1);
    this.shadow.position.set(-direction.x * lift * 0.08 + 0.06, -direction.y * lift * 0.08 - 0.08, -0.055);
    this.shadow.material.uniforms.uOpacity.value = 0.3 + lift * 0.18;
  }

  setTearWarning(snapshot: PeelSnapshot, warning: ReturnType<PeelSimulation["tearWarning"]>, showGesture: boolean) {
    this.tearStrain.z = 0;
    this.warningGesture = showGesture && warning && warning.risk >= GESTURE_START_RISK ? warning : null;
    if (!this.warningGesture) this.warningOverlay.hide();
    if (!warning || warning.risk <= CREASE_START_RISK || !this.curlSeamCount) return;

    const strength = THREE.MathUtils.smoothstep(warning.risk, CREASE_START_RISK, 1);
    const { grab, direction, frontDepth } = snapshot;
    const { width, height } = this.simulation;
    const aim = this.uvToWorld(grab);
    aim.x += direction.x * frontDepth * this.stickerHeight;
    aim.y += direction.y * frontDepth * this.stickerHeight;
    let closest = Infinity;
    // The queue starts with the actual seam cells, including around holes and concave edges.
    for (let i = 0; i < this.curlSeamCount; i++) {
      const cell = this.curlQueue[i];
      const x = ((cell % width + 0.5) / width - 0.5) * this.stickerWidth;
      const y = ((Math.floor(cell / width) + 0.5) / height - 0.5) * this.stickerHeight;
      const distance = (x - aim.x) ** 2 + (y - aim.y) ** 2;
      if (distance >= closest) continue;
      closest = distance;
      this.tearStrain.set(x, y, strength);
    }
    if (!this.keepCrease || strength < 0.28) return;
    const piece = this.stickerLayout.pieceAtCell(this.simulation.activeGripCell);
    if (!piece) return;
    const { x, y } = this.tearStrain;
    const last = this.lastCrease;
    if (last && Math.hypot(x - last.x, y - last.y) < 0.16 && strength <= last.strength + 0.12) return;
    this.lastCrease = { x, y, strength };
    if (stampCrease(this.creasePixels, width, height, { x: this.stickerWidth, y: this.stickerHeight },
      { x, y }, direction, strength, cell => this.stickerLayout.pieceAtCell(cell) === piece)) this.creaseTexture.needsUpdate = true;
  }

  private drawTearWarning() {
    if (!this.warningGesture || !this.dragInput) return;
    this.warningOverlay.drawGesture(this.dragInput.screen, this.domElement.getBoundingClientRect(), this.warningGesture.redirect);
  }

  private moveDissolve(pointer: Vec2) {
    if (!this.heldDissolve) {
      const back = this.stickerMeshes.find(({ material }) => material.uniforms.uLayer.value === 2 && material.side === THREE.BackSide);
      if (!back) return;
      const { width, height } = this.simulation;
      const data = new Uint8Array(width * height * 4);
      this.simulation.writeDetachedTexture(data);
      extendStateTexture(data, this.stateSources);
      const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      let bounds = this.movingBounds;
      const material = this.cloneMaterial(back.material);
      const uniforms = material.uniforms as unknown as PeelUniforms;
      material.defines = { ...material.defines, PEEL_DETACHED: 1 };
      material.side = THREE.DoubleSide;
      material.forceSinglePass = true;
      // Match the curled position at the grab so the sheet opens around the player's grip.
      const depth = uniforms.uFrontDepth.value;
      const radius = uniforms.uRadius.value;
      const length = depth * (1 + uniforms.uStretch.value);
      const theta = Math.min(length / radius, Math.PI);
      const shift = depth + Math.max(length - Math.PI * radius, 0) - radius * Math.sin(theta);
      const direction = uniforms.uDirection.value;
      const flatOffset = uniforms.uFlatOffset.value.copy(direction).multiplyScalar(shift);
      uniforms.uState.value = texture;
      const mesh = new THREE.Mesh(back.geometry, material);
      mesh.renderOrder = back.renderOrder + 6;
      mesh.position.z = back.position.z;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      if (bounds && this.movingRegion) {
        const { x, y, width, height } = this.movingRegion;
        const grab = uniforms.uGrab.value;
        const along = (x - grab.x) * direction.x + (y - grab.y) * direction.y;
        const diagonal = Math.abs(1 - 2 * direction.x ** 2);
        const cross = Math.abs(2 * direction.x * direction.y);
        bounds = unionBounds(bounds, regionBounds({
          x: x - 2 * along * direction.x + flatOffset.x,
          y: y - 2 * along * direction.y + flatOffset.y,
          width: diagonal * width + cross * height,
          height: cross * width + diagonal * height,
        }, 0.15));
      }
      const { liftedCells, totalCells } = this.simulation.diagnostics().current;
      this.heldDissolve = {
        texture, mesh, detachedAt: performance.now(), releasedAt: null, fadeStart: null,
        alignmentMs: detachedAlignmentDuration(liftedCells, totalCells),
        origin: { ...pointer }, offset: { x: 0, y: 0 }, bounds,
      };
      this.dissolves.push(this.heldDissolve);
    }
    const shape = this.heldDissolve;
    shape.offset.x = (pointer.x - shape.origin.x) * this.stickerWidth;
    shape.offset.y = (pointer.y - shape.origin.y) * this.stickerHeight;
    shape.mesh.position.setX(shape.offset.x).setY(shape.offset.y);
  }

  private cloneMaterial(source: THREE.ShaderMaterial) {
    const material = source.clone();
    const uniforms = material.uniforms as unknown as PeelUniforms;
    uniforms.uArt.value = source.uniforms.uArt.value;
    uniforms.uPuff.value = source.uniforms.uPuff.value;
    uniforms.uScene.value = source.uniforms.uScene.value;
    uniforms.uReleaseHistory.value = this.releaseTexture;
    uniforms.uAttachedCurl.value = this.curlTexture;
    uniforms.uRestState.value = this.stateTexture;
    uniforms.uSettlingMask.value = this.stateTexture;
    uniforms.uSavedCreases.value = this.creaseTexture;
    uniforms.uTearStrain.value.set(0, 0, 0);
    return material;
  }

  settleLift(liftedCells: number, totalCells: number) {
    if (!liftedCells || !this.movingRegion || !this.movingBounds || this.reducedMotion.matches) return;
    this.clearSettling();
    const { width, height } = this.simulation;
    const state = new THREE.DataTexture(this.stateData.slice(), width, height, THREE.RGBAFormat);
    const curl = new THREE.DataTexture(this.attachedCurl.pixels.slice(), width, height, THREE.RedFormat, THREE.HalfFloatType);
    for (const texture of [state, curl]) {
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
    }
    const meshes = this.stickerMeshes.filter(mesh => mesh.material.uniforms.uLayer.value === 2).map(source => {
      const material = this.cloneMaterial(source.material);
      material.defines = { ...material.defines, PEEL_SETTLING: 1 };
      material.uniforms.uState.value = state;
      material.uniforms.uAttachedCurl.value = curl;
      material.uniforms.uTearStrain.value.copy(this.tearStrain);
      const mesh = new THREE.Mesh(source.geometry, material);
      mesh.position.copy(source.position);
      mesh.renderOrder = source.renderOrder;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    });
    for (const material of this.materials) {
      material.uniforms.uSettlingMask.value = state;
      material.uniforms.uHideSettling.value = 1;
    }
    this.settling = {
      meshes, state, curl, from: this.movingBounds, to: regionBounds(this.movingRegion, 0.022 + this.reliefHeight),
      started: null, duration: releaseSettleDuration(liftedCells, totalCells, this.tearStrain.z > 0), progress: 0,
    };
  }

  private clearSettling() {
    const flap = this.settling;
    if (!flap) return;
    for (const mesh of flap.meshes) {
      this.scene.remove(mesh);
      mesh.material.dispose();
    }
    flap.state.dispose();
    flap.curl.dispose();
    this.settling = null;
    for (const material of this.materials) {
      material.uniforms.uSettlingMask.value = this.stateTexture;
      material.uniforms.uHideSettling.value = 0;
    }
  }

  clearReleaseAnimations() {
    this.clearSettling();
    for (const shape of this.dissolves) this.disposeDissolve(shape);
    this.dissolves.length = 0;
    this.heldDissolve = null;
    this.clearCreases();
  }

  private clearCreases() {
    this.lastCrease = null;
    this.creasePixels.fill(0);
    this.creaseTexture.needsUpdate = true;
  }

  private disposeDissolve(shape: DissolvingShape) {
    this.scene.remove(shape.mesh);
    shape.mesh.material.dispose();
    shape.texture.dispose();
  }

  setAppearance(appearance: PeelAppearance) {
    this.settingsPreviewDirty = true;
    this.opticsMode = appearance.optics;
    this.frontFinish = appearance.face;
    if (this.keepCrease && !appearance.keepCrease) this.clearCreases();
    this.keepCrease = appearance.keepCrease === 1;
    const ridgeHeight = appearance.ridge ? RIDGE_HEIGHT : 0;
    const curlHeight = appearance.gripCurl ? GRIP_CURL_HEIGHT : 0;
    this.reliefHeight = ridgeHeight + curlHeight;
    if ((appearance.face === PUFFY_FINISH || usesFrontRefraction(appearance.face)) && !this.puffTexture) {
      const width = this.artwork.naturalWidth;
      const height = this.artwork.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(this.artwork, 0, 0);
      const image = context.getImageData(0, 0, width, height).data;
      const alpha = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) alpha[y * width + x] = image[((height - y - 1) * width + x) * 4 + 3];
      }
      this.puffTexture = new THREE.DataTexture(puffyNormals(alpha, width, height), width, height, THREE.RGBAFormat);
      this.puffTexture.minFilter = this.puffTexture.magFilter = THREE.LinearFilter;
      this.puffTexture.needsUpdate = true;
    }
    const backgroundPreset = BACKGROUNDS[appearance.background];
    const background = backgroundPreset.color;
    const plainBackground = "plain" in backgroundPreset;
    this.surface.material = plainBackground ? this.plainSurfaceMaterial : this.surfaceMaterial;
    this.plainSurfaceMaterial.color.set(background);
    this.surfaceMaterial.emissive.set(background);
    this.surfaceMaterial.emissiveIntensity = appearance.background === 0 ? 0 : 0.95;
    this.scene.background = appearance.background === 0 ? null : new THREE.Color(background).multiplyScalar(plainBackground ? 1 : 0.62);
    const glassEnabled = appearance.glassDepth === 1;
    if (glassEnabled && !this.glassDepth) {
      this.glassDepth = new GlassDepthScene();
      this.scene.add(this.glassDepth.mesh);
    }
    if (this.glassDepth) {
      this.glassDepth.mesh.visible = glassEnabled;
      this.glassDepth.setBackdrop(background);
    }
    this.surface.visible = !glassEnabled;
    this.castShadow = shadowVisible(appearance);
    this.shadow.visible = !glassEnabled && this.castShadow;

    const sticker = STICKER_COLORS[appearance.sticker].color;
    const moving = [...this.dissolves.map(shape => shape.mesh), ...(this.settling?.meshes ?? [])];
    for (const material of [...this.materials, ...moving.map(mesh => mesh.material)]) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uWhiteArtwork.value = sticker || this.originalWhiteArtwork ? 1 : 0;
      uniforms.uStickerColor.value.set(sticker ?? "#ffffff");
      uniforms.uCaramelTint.value.set(sticker ?? "#e99b50");
      uniforms.uKeepCrease.value = this.keepCrease ? 1 : 0;
      uniforms.uFaceFinish.value = appearance.face;
      if (this.puffTexture) uniforms.uPuff.value = this.puffTexture;
      uniforms.uBackFinish.value = appearance.back;
      uniforms.uFilmOptics.value = appearance.optics;
      uniforms.uOpticsTint.value.setHex(FILM_FILTERS[appearance.filmFilter].color, THREE.LinearSRGBColorSpace);
      uniforms.uReleaseFinish.value = appearance.released;
      uniforms.uRidgeHeight.value = ridgeHeight;
      uniforms.uGripCurlHeight.value = curlHeight;
    }
  }

  setLiftedTransparency(transparency: number) {
    this.settingsPreviewDirty = true;
    const opacity = 1 - THREE.MathUtils.clamp(transparency, 0, 0.95);
    for (const material of this.materials) {
      (material.uniforms as unknown as PeelUniforms).uLiftedOpacity.value = opacity;
    }
    for (const shape of this.dissolves) shape.mesh.material.uniforms.uLiftedOpacity.value = opacity;
    for (const mesh of this.settling?.meshes ?? []) mesh.material.uniforms.uLiftedOpacity.value = opacity;
  }

  screenToSticker(clientX: number, clientY: number, depth = 0): Vec2 | null {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    this.hitPlane.constant = -depth;
    if (!this.raycaster.ray.intersectPlane(this.hitPlane, point)) return null;
    return { x: point.x / this.stickerWidth + 0.5, y: point.y / this.stickerHeight + 0.5 };
  }

  gripGap(snapshot: PeelSnapshot, profile: CurlProfile) {
    const input = this.dragInput;
    if (!input || !snapshot.pulling || snapshot.torn || snapshot.detached || !this.movingRegion) return null;

    // Project the grabbed point using the same attached curl as the shader.
    const grab = this.uvToWorld(snapshot.grab);
    const worldDepth = snapshot.frontDepth * this.stickerHeight;
    this.prepareAttachedCurl(grab, snapshot.direction, worldDepth, profile);
    const depth = this.attachedCurl.sampleDepth(snapshot.grab, worldDepth);
    const radius = curlRadius(profile);
    const length = depth * (1 + tensionStretch(snapshot.stress, snapshot.tearThreshold));
    const theta = Math.min(length / radius, Math.PI);
    const shift = depth + Math.max(length - Math.PI * radius, 0) - radius * Math.sin(theta);
    const rise = 0.018 + radius * (1 - Math.cos(theta));
    // Measure contact in the gesture's original projection so a moving camera
    // cannot create tension. Convert assisted travel back to physical pixels.
    const { cameraStart, unitsPerPixel, assist } = input;
    const perspective = cameraStart.z / (cameraStart.z - 0.004 - rise);
    const contact = this.uvToWorld(input.point);
    let dx = cameraStart.x + (grab.x + snapshot.direction.x * shift - cameraStart.x) * perspective - contact.x;
    let dy = cameraStart.y + (grab.y + snapshot.direction.y * shift - cameraStart.y) * perspective - contact.y;
    if (assist) {
      const { direction, gain } = assist;
      const along = (dx * direction.x + dy * direction.y) * (1 - 1 / gain);
      dx -= along * direction.x;
      dy -= along * direction.y;
    }
    return Math.hypot(dx, dy) / unitsPerPixel;
  }

  tornGripContact() {
    const input = this.dragInput;
    return input && this.screenToSticker(input.screen.x, input.screen.y, TORN_LAYER_Z);
  }

  setZoom(zoom: number) {
    this.zoom = zoom;
  }

  setCameraSettings(settings: CameraSettings) {
    this.cameraSettings = settings;
  }

  get touchMode() { return this.touchCameraMode; }

  setTouchCameraMode(mode: TouchCameraMode | null) {
    if (this.touchCameraMode === mode) return;
    this.touchCameraMode = mode;
    this.resetTouchView();
  }

  setTouchPointPending(pending: boolean) {
    this.touchPointPending = pending;
  }

  get touchView(): TouchCameraView {
    const overview = this.touchCameraMode === "focus" ? this.overviewDistance() : 0;
    return {
      focused: this.focusedPiece !== null,
      canFocus: overview > 0 && this.stickerLayout.pieces.length > 1 && this.stickerLayout.pieces.some(piece =>
        this.simulation.state[piece.sample] !== Cell.outside
        && this.focusDistance(this.worldBounds(piece.area), overview) < overview * 0.87),
      zoom: this.manualView.zoom,
    };
  }

  resetTouchView() {
    this.focusedPiece = null;
    this.gluedBounds = null;
    this.manualView = { center: this.boundsCenter(this.touchBounds), zoom: 1 };
    this.onTouchViewChange?.(this.touchView);
  }

  focusAt(point: Vec2): "focus" | "overview" | null {
    if (this.touchCameraMode !== "focus") return null;
    const units = 2 * this.camera.position.z * this.tangent / this.viewportHeight;
    const radius = this.focusedPiece ? { x: 0, y: 0 } : { x: 10 * units / this.stickerWidth, y: 10 * units / this.stickerHeight };
    const piece = this.stickerLayout.hit(point, radius, this.simulation.state);
    if (!piece && this.focusedPiece) {
      this.resetTouchView();
      return "overview";
    }
    if (!piece || piece === this.focusedPiece || !this.canFocusPiece(piece)) return null;
    this.focusPiece(piece);
    return "focus";
  }

  private canFocusPiece(piece: StickerPiece) {
    const overview = this.overviewDistance();
    return this.focusDistance(this.worldBounds(piece.area), overview) < overview * 0.87;
  }

  private focusPiece(piece: StickerPiece) {
    this.focusedPiece = piece;
    this.updateGluedBounds();
    this.onTouchViewChange?.(this.touchView);
  }

  setFollowCurl(enabled: boolean) {
    if (this.followCurl === enabled) return;
    this.followCurl = enabled;
    this.updateGluedBounds();
  }

  updateTouchPeel(snapshot: PeelSnapshot) {
    if (this.touchCameraMode !== "focus") return;
    if (this.dragInput && !this.dragInput.working && this.movingRegion
        && snapshot.frontDepth > 0 && !snapshot.torn && !snapshot.outwardPulling) {
      const piece = this.stickerLayout.pieceAtCell(this.simulation.activeGripCell);
      if (piece && (this.followCurl || this.canFocusPiece(piece))) {
        this.dragInput.working = true;
        if (piece !== this.focusedPiece) {
          this.focusPiece(piece);
          return;
        }
      }
    }
    this.updateGluedBounds();
  }

  private updateGluedBounds() {
    const area = this.followCurl && this.focusedPiece
      ? this.stickerLayout.areaInState(this.focusedPiece, this.simulation.state, Cell.adhered)
      : null;
    this.gluedBounds = area ? this.worldBounds(area) : null;
  }

  adjustManualView(factor: number, previous?: Vec2, next?: Vec2) {
    if (this.touchCameraMode !== "manual" || this.dragInput) return;
    const rect = this.domElement.getBoundingClientRect();
    const offset = (p?: Vec2) => p
      ? { x: p.x - rect.left - rect.width / 2, y: rect.top + rect.height / 2 - p.y }
      : { x: 0, y: 0 };
    const units = 2 * (this.overviewDistance() - this.touchBounds.z) * this.tangent / this.viewportHeight;
    const previousZoom = this.manualView.zoom;
    this.manualView = moveManualView(this.manualView, offset(previous), offset(next), factor, units, this.touchBounds);
    if (next && !this.settling && this.dissolves.length === 0) {
      this.cameraMotion = null;
      this.frameCamera(performance.now());
    }
    if (this.manualView.zoom !== previousZoom) this.onTouchViewChange?.(this.touchView);
  }

  setMiniMap(canvas: HTMLCanvasElement | null, outline: HTMLElement | null) {
    this.miniMap = canvas && outline ? { canvas, outline } : null;
    this.refreshMiniMap();
  }

  refreshMiniMap() {
    if (!this.miniMap) return;
    const { canvas } = this.miniMap;
    const { width, height, state } = this.simulation;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = state[y * width + x];
        if (cell === Cell.outside || cell === Cell.torn) continue;
        const offset = ((height - 1 - y) * width + x) * 4;
        image.data[offset] = 190;
        image.data[offset + 1] = 228;
        image.data[offset + 2] = 218;
        image.data[offset + 3] = cell === Cell.released ? 132 : 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  setSettingsOpen(open: boolean) {
    this.settingsOpen = open;
  }

  beginDrag(clientX: number, clientY: number, point: Vec2) {
    this.clearSettling();
    const start = { x: clientX, y: clientY };
    this.dragInput = {
      screen: start, start, point, cameraStart: this.camera.position.clone(), working: false, assist: null,
      unitsPerPixel: 2 * this.camera.position.z * this.tangent / this.viewportHeight,
    };
    if (this.touchCameraMode && this.cameraMotion) this.cameraMotion.velocity = { x: 0, y: 0, z: 0 };
  }

  dragToSticker(clientX: number, clientY: number) {
    const input = this.dragInput;
    if (!input) return null;
    // Pointer capture lets the player keep peeling across the whole window, including over the HUD.
    const bounds = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const x = THREE.MathUtils.clamp(clientX, bounds.left, bounds.right);
    const y = THREE.MathUtils.clamp(clientY, bounds.top, bounds.bottom);
    const dx = x - input.screen.x;
    const dy = input.screen.y - y;
    if (!dx && !dy) return null;
    const { unitsPerPixel } = input;
    let worldX = dx * unitsPerPixel;
    let worldY = dy * unitsPerPixel;
    const reach = this.simulation.remainingPeelTravel();
    if (reach) {
      const { direction, distance } = reach;
      const forward = dx * direction.x + dy * direction.y;
      if (forward > 0) {
        const heading = { x: direction.x, y: -direction.y };
        const travel = (input.screen.x - input.start.x) * heading.x + (input.screen.y - input.start.y) * heading.y;
        const scale = dragScaleForReach(input.screen, heading, bounds, distance * this.stickerHeight,
          unitsPerPixel, travel, this.cameraSettings.edgeClearance);
        const extra = forward * (scale - unitsPerPixel);
        worldX += extra * direction.x;
        worldY += extra * direction.y;
        input.assist = { direction, gain: scale / unitsPerPixel };
      }
    }
    input.point = {
      x: input.point.x + worldX / this.stickerWidth,
      y: input.point.y + worldY / this.stickerHeight,
    };
    input.screen = { x, y };
    return input.point;
  }

  endDrag() {
    this.dragInput = null;
    this.lastCrease = null;
    this.warningGesture = null;
    this.tearStrain.z = 0;
    this.warningOverlay.hide();
    if (this.heldDissolve) this.heldDissolve.releasedAt ??= performance.now();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver.disconnect();
    this.clearReleaseAnimations();
    for (const mesh of this.stickerMeshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.shadow.geometry.dispose();
    this.shadow.material.uniforms.uShadow.value.dispose();
    this.shadow.material.dispose();
    this.stateTexture.dispose();
    this.curlTexture.dispose();
    this.releaseTexture.dispose();
    this.creaseTexture.dispose();
    this.puffTexture?.dispose();
    this.filmOptics?.dispose();
    this.glassDepth?.dispose();
    this.surface.geometry.dispose();
    this.surfaceMaterial.map?.dispose();
    this.surfaceMaterial.dispose();
    this.plainSurfaceMaterial.dispose();
    this.renderer.dispose();
    this.domElement.remove();
    this.warningOverlay.dispose();
  }

  private uvToWorld(point: Vec2) {
    return new THREE.Vector2((point.x - 0.5) * this.stickerWidth, (point.y - 0.5) * this.stickerHeight);
  }

  private resize() {
    const couldFocus = this.touchView.canFocus;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.updateProjectionMatrix();
    this.settingsPreviewDirty = true;
    if (!this.cameraMotion) this.frameCamera(performance.now());
    const view = this.touchView;
    if (view.canFocus !== couldFocus) this.onTouchViewChange?.(view);
  }

  private worldBounds(area: StickerArea): PeelBounds {
    return {
      left: (area.left - 0.5) * this.stickerWidth, right: (area.right - 0.5) * this.stickerWidth,
      bottom: (area.bottom - 0.5) * this.stickerHeight, top: (area.top - 0.5) * this.stickerHeight,
      z: this.stickerBounds.z,
    };
  }

  private boundsCenter(bounds: PeelBounds): Vec2 {
    return { x: (bounds.left + bounds.right) / 2, y: (bounds.bottom + bounds.top) / 2 };
  }

  private touchFitDistance(bounds: PeelBounds, fill: number) {
    const span = Math.max((bounds.right - bounds.left) * this.viewportHeight / this.viewportWidth,
      bounds.top - bounds.bottom);
    return bounds.z + span / (2 * this.tangent * fill);
  }

  private overviewDistance() {
    const zoom = this.touchCameraMode === "manual" ? 1 : this.zoom;
    return this.touchFitDistance(this.touchBounds, Math.min(0.945, 0.92 * zoom));
  }

  private focusDistance(bounds: PeelBounds, overview: number) {
    return Math.max(this.touchFitDistance(bounds, 0.66), bounds.z + (overview - bounds.z) / 3);
  }

  private updateMiniMapOutline() {
    if (!this.miniMap || this.manualView.zoom === 1) return;
    const { x, y, z } = this.camera.position;
    const halfHeight = (z - this.touchBounds.z) * this.tangent;
    const halfWidth = halfHeight * this.camera.aspect;
    const percent = (unit: number) => `${(THREE.MathUtils.clamp(unit, 0, 1) * 100).toFixed(2)}%`;
    const { style } = this.miniMap.outline;
    style.left = percent(0.5 + (x - halfWidth) / this.stickerWidth);
    style.right = percent(0.5 - (x + halfWidth) / this.stickerWidth);
    style.top = percent(0.5 - (y + halfHeight) / this.stickerHeight);
    style.bottom = percent(0.5 + (y - halfHeight) / this.stickerHeight);
  }

  private frameCamera(now: number) {
    const waitingForRelease = this.focusedPiece && !this.dragInput && this.dissolves.length > 0
      && this.simulation.state[this.focusedPiece.sample] === Cell.outside;
    if ((this.touchPointPending || waitingForRelease) && this.cameraMotion) {
      this.lastCameraTime = now;
      return;
    }
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const shortSide = Math.min(width, height);
    const touch = this.touchCameraMode !== null;
    const focusMode = this.touchCameraMode === "focus";
    const manualCrop = this.touchCameraMode === "manual" && this.manualView.zoom > 1;
    const held = this.heldDissolve;
    const heldBounds = held?.bounds && this.dragInput ? translateBounds(held.bounds, held.offset) : null;
    const focusBounds = this.focusedPiece
      ? (this.followCurl ? this.gluedBounds ?? heldBounds ?? this.movingBounds : null) ?? this.worldBounds(this.focusedPiece.area)
      : null;
    const wholeBounds = touch ? this.touchBounds : this.stickerBounds;
    const restBounds = focusBounds ?? wholeBounds;
    const fill = Math.min(0.945, (touch ? 0.92 : 0.82) * (this.touchCameraMode === "manual" ? 1 : this.zoom));
    const relief = this.simulation.releasedGrips.size > 0 ? this.reliefHeight : 0;
    const bounds = manualCrop ? [] : [{ ...restBounds, z: restBounds.z + relief }];
    const pan = touch || this.cameraSettings.pan;
    if (this.movingBounds) bounds.push(this.movingBounds);
    if (this.settling && !focusMode) {
      const { from, to, progress } = this.settling;
      const lerp = THREE.MathUtils.lerp;
      bounds.push({
        left: lerp(from.left, to.left, progress), right: lerp(from.right, to.right, progress),
        bottom: lerp(from.bottom, to.bottom, progress), top: lerp(from.top, to.top, progress),
        z: lerp(from.z, to.z, progress),
      });
    }
    for (const shape of this.dissolves) {
      const foreground = this.dragInput ? shape === this.heldDissolve
        : !focusMode && (shape.fadeStart === null || now - shape.fadeStart < DISSOLVE_MS * 0.65);
      if (shape.bounds && foreground) bounds.push(translateBounds(shape.bounds, shape.offset));
    }
    const overview = this.touchFitDistance(wholeBounds, fill);
    const desired = manualCrop ? wholeBounds.z + (overview - wholeBounds.z) / this.manualView.zoom
      : focusBounds ? Math.min(overview, this.focusDistance(focusBounds, overview)) : overview;
    const grabPose = touch ? this.dragInput?.cameraStart : null;
    const followGrip = focusMode && this.dragInput?.working;
    const base = Math.max(desired, followGrip ? 0 : grabPose?.z ?? 0);
    let center: Vec2 = grabPose ?? (manualCrop ? this.manualView.center : this.boundsCenter(restBounds));
    const comfort = followGrip ? Math.min(32, shortSide * 0.08) : Math.min(34, shortSide * (1 - fill) / 2);
    const fit = bounds.length ? fitFrustum(bounds, this.tangent, width, height, comfort, pan) : null;
    if (followGrip && grabPose && this.dragInput) {
      // Zoom around the touch while leaving the gesture's physics projection alone.
      const rect = this.domElement.getBoundingClientRect();
      const { x, y } = this.dragInput.screen;
      const shift = (grabPose.z - Math.max(base, fit?.distance ?? 0)) * 2 * this.tangent / height;
      center = {
        x: grabPose.x + (x - rect.left - width / 2) * shift,
        y: grabPose.y + (rect.top + height / 2 - y) * shift,
      };
    }
    // Focus uses one eased pan/zoom target. A separate instantaneous clamp
    // can make a piece jump just before that transition starts.
    const protect = !touch || this.dragInput || this.settling || this.dissolves.length > 0;
    const guard = !focusMode && protect && bounds.length
      ? fitFrustum(bounds, this.tangent, width, height, Math.min(9, shortSide * 0.024), pan) : null;
    const dt = THREE.MathUtils.clamp((now - this.lastCameraTime) / 1000, 0, 0.05);
    // Respect reduced motion for mobile camera commands; preserve the peel's reach guard.
    const motion = touch && !protect && this.reducedMotion.matches ? null : this.cameraMotion;
    this.cameraMotion = stepCamera(motion, fit, guard, base, dt, pan, center, focusMode);
    this.lastCameraTime = now;
    const { x, y, z } = this.cameraMotion.pose;
    this.camera.position.set(x, y, z);
    const halfHeight = (z - this.surface.position.z) * this.tangent;
    const scaleX = Math.max(1, (Math.abs(x) + halfHeight * this.camera.aspect) / 11 * 1.01);
    const scaleY = Math.max(1, (Math.abs(y) + halfHeight) / 9 * 1.01);
    this.surface.scale.set(scaleX, scaleY, 1);
    this.surfaceMaterial.map?.repeat.set(1.6 * scaleX, 1.6 * scaleY);
    this.surfaceMaterial.map?.offset.set(0.8 * (1 - scaleX), 0.8 * (1 - scaleY));
    const far = Math.max(40, z * 2 + 2);
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.updateMiniMapOutline();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    // Keep the preview responsive while the settings dialog covers the stage.
    if (this.settingsOpen && !this.settingsPreviewDirty && !this.dragInput && !this.settling && !this.dissolves.length) return;
    this.settingsPreviewDirty = false;
    const now = performance.now();
    const phase = this.dissolves.length || this.settling ? "dissolve" : this.dragInput ? "drag" : "idle";
    if (this.settling && this.settling.started !== null) {
      const { started, duration, meshes } = this.settling;
      const elapsed = now - started;
      if (elapsed >= duration) {
        this.clearSettling();
      } else {
        const progress = THREE.MathUtils.smoothstep(elapsed, 0, duration);
        this.settling.progress = progress;
        for (const mesh of meshes) mesh.material.uniforms.uRelax.value = progress;
      }
    }
    for (let i = this.dissolves.length - 1; i >= 0; i--) {
      const shape = this.dissolves[i];
      const { alignment, fadeStart } = detachedAnimation(now, shape.detachedAt, shape.releasedAt,
        this.reducedMotion.matches ? 0 : shape.alignmentMs);
      shape.fadeStart = fadeStart;
      const fadeElapsed = fadeStart === null ? 0 : Math.max(0, now - fadeStart);
      if (fadeElapsed >= DISSOLVE_MS) {
        this.disposeDissolve(shape);
        this.dissolves.splice(i, 1);
      } else {
        shape.mesh.material.uniforms.uRelax.value = alignment;
        shape.mesh.material.uniforms.uDissolve.value = fadeElapsed / DISSOLVE_MS;
      }
    }
    if (this.focusedPiece && !this.dragInput && this.dissolves.length === 0
        && this.simulation.state[this.focusedPiece.sample] === Cell.outside) {
      this.resetTouchView();
    }
    const cameraStarted = performance.now();
    this.frameCamera(now);
    const renderStarted = performance.now();
    const fronts = usesFrontRefraction(this.frontFinish);
    const backs = (this.opticsMode > 0 || usesTranslucentCoating(this.frontFinish))
      && (this.movingRegion !== null || this.dissolves.length > 0 || this.settling !== null);
    const meshes = [...this.stickerMeshes, ...(this.settling?.meshes ?? []), ...this.dissolves.map(shape => shape.mesh)];
    if (this.glassDepth?.mesh.visible) {
      this.glassDepth.update(this.renderer, this.camera, meshes.filter(mesh => mesh.material.side !== THREE.BackSide),
        now, this.dragInput !== null, this.castShadow);
    }
    if (fronts || backs) {
      this.filmOptics ??= new FilmOptics();
      const refracting = meshes.filter(mesh => mesh.material.side === THREE.FrontSide ? fronts : backs);
      this.filmOptics.capture(this.renderer, this.scene, this.camera, refracting);
      for (const mesh of refracting) {
        mesh.material.uniforms.uScene.value = this.filmOptics.texture;
        mesh.material.uniforms.uViewport.value.copy(this.filmOptics.size);
        mesh.material.uniforms.uMaterialTime.value = this.reducedMotion.matches ? 0 : now / 1000;
      }
    }
    this.renderer.render(this.scene, this.camera);
    // The first draw can compile the settling shaders. Give the animation its full duration afterward.
    if (this.settling?.started === null) this.settling.started = performance.now();
    this.drawTearWarning();
    this.frameTimings.recordFrame(now, {
      phase,
      visible: document.visibilityState === "visible",
      animationMs: cameraStarted - now,
      cameraMs: renderStarted - cameraStarted,
      renderSubmitMs: performance.now() - renderStarted,
    });
  };
}
