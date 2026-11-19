import * as THREE from "three";
import { BACKGROUNDS, STICKER_COLORS, type PeelAppearance } from "./PeelAppearance";
import { approachesScreenEdge, dragScaleForReach, fitDistance, includeCurl, MAX_TENSION_STRETCH, stepCameraDistance, type PeelBounds, type PeelRegion } from "./PeelFraming";
import { nearestStateSources, extendStateTexture, writeCurlDistances } from "./StateTexture";
import { FrameTimings } from "./FrameTimings";
import { Cell, type CurlProfile, type PeelSimulation, type PeelSnapshot, type Vec2 } from "../peel/PeelSimulation";

const STICKER_WIDTH = 4.8;
const RELAX_MS = 420;
const DISSOLVE_MS = 1800;
const TORN_LAYER_Z = 0.086;
const curlRadius = (profile: CurlProfile) => profile === "cone" ? 0.28 : 0.32;
const tensionStretch = (stress: number, threshold: number) => threshold > 0
  ? MAX_TENSION_STRETCH * THREE.MathUtils.smoothstep(stress / threshold, 0.9, 1) : 0;

type DissolvingShape = {
  texture: THREE.DataTexture;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  started: number;
  origin: Vec2;
  offset: Vec2;
  bounds: PeelBounds | null;
};

type PeelUniforms = {
  uArt: { value: THREE.Texture };
  uWhiteArtwork: { value: number };
  uStickerColor: { value: THREE.Color };
  uFaceFinish: { value: number };
  uBackFinish: { value: number };
  uReleaseFinish: { value: number };
  uState: { value: THREE.DataTexture };
  uCurlDistances: { value: THREE.DataTexture };
  uCurlCellSize: { value: number };
  uReleaseHistory: { value: THREE.DataTexture };
  uLayer: { value: number };
  uFilmColor: { value: THREE.Color };
  uLiftedOpacity: { value: number };
  uGrab: { value: THREE.Vector2 };
  uDirection: { value: THREE.Vector2 };
  uFrontDepth: { value: number };
  uRadius: { value: number };
  uCone: { value: number };
  uStress: { value: number };
  uStretch: { value: number };
  uRelax: { value: number };
  uFlatOffset: { value: THREE.Vector2 };
  uDissolve: { value: number };
  uTornOffset: { value: THREE.Vector2 };
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
  uniform sampler2D uCurlDistances;
  uniform float uCurlCellSize;
  uniform float uRelax;
  uniform vec2 uFlatOffset;
  uniform vec2 uTornOffset;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;

  const float PI = 3.141592653589793;

  void main() {
    vUv = uv;
    vec3 p = position;
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
      float arcLength = q * (1.0 + uStretch);
      float coneScale = mix(1.0, clamp(1.0 + lateral * 0.24, 0.58, 1.46), uCone);
      float radius = max(0.12, uRadius * coneScale);
      theta = min(arcLength / radius, PI);
      float extra = max(arcLength - PI * radius, 0.0);
      p.xy += direction * (q + extra - radius * sin(theta));
      p.z = 0.018 + radius * (1.0 - cos(theta));
      #ifndef PEEL_DETACHED
        // Close small gaps near the glued edge without shortening the curl.
        // Large displacements need a bounded correction to avoid stretching the sheet.
        float cellsFromSeam = texture2D(uCurlDistances, uv).r * 255.0;
        vec3 displacement = p - position;
        float nearSeam = 1.0 - smoothstep(3.0, 16.0, cellsFromSeam);
        float correction = nearSeam * min(1.0, 8.0 * uCurlCellSize / max(length(displacement), 0.0001));
        p -= correction * displacement;
        theta *= 1.0 - correction;
      #endif
    } else if (uLayer > 0.5) {
      p.z += 0.018;
    }
    vCurl = smoothstep(0.0, PI, theta);
    #ifdef PEEL_DETACHED
      // Open around the grip with the same handedness as the folded-over flap.
      vec2 flatPosition = position.xy - 2.0 * along * direction + uFlatOffset;
      p = mix(p, vec3(flatPosition, 0.14), uRelax);
      theta = mix(theta, PI, uRelax);
      vCurl *= 1.0 - uRelax;
    #endif
    vNormalWorld = vec3(direction * sin(theta), cos(theta));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uArt;
  uniform float uWhiteArtwork;
  uniform vec3 uStickerColor;
  uniform float uFaceFinish;
  uniform float uBackFinish;
  uniform float uReleaseFinish;
  uniform sampler2D uState;
  uniform sampler2D uReleaseHistory;
  uniform float uLayer;
  uniform vec3 uFilmColor;
  uniform float uLiftedOpacity;
  uniform float uStress;
  uniform float uDissolve;
  uniform vec2 uDirection;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;

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
    if (layerCoverage < 0.01) discard;
    float silhouette = texture2D(uArt, vUv).a;
    if (silhouette <= 0.0) discard;

    // Three.js reverses WebGL winding for BackSide materials, so
    // gl_FrontFacing does not identify the sticker's physical side.
    #ifdef PEEL_BACK_FACE
      vec3 normal = normalize(-vNormalWorld);
    #else
      vec3 normal = normalize(vNormalWorld);
    #endif
    #ifdef PEEL_DETACHED
      if (normal.z < 0.0) normal = -normal;
    #endif
    vec3 lightDirection = normalize(vec3(-0.38, 0.55, 0.74));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float grazing = pow(1.0 - abs(normal.z), 2.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
    #ifdef PEEL_BACK_FACE
    vec3 filmColor = uFilmColor * (0.78 + diffuse * 0.14);
    filmColor += vec3(1.0, 0.82, 0.92) * (grazing * 0.18 + specular * 0.24);
    filmColor = mix(filmColor, vec3(1.0, 0.28, 0.52), uStress * vCurl * 0.12);
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
    #else
    vec3 artworkColor = mix(texture2D(uArt, vUv).rgb, uStickerColor, uWhiteArtwork);
    vec3 printedColor = artworkColor * (0.61 + diffuse * 0.43);
    printedColor += vec3(0.48, 0.40, 0.56) * grazing * 0.15 + specular * 0.22;
    printedColor = mix(printedColor, vec3(1.0, 0.52, 0.66), uStress * vCurl * 0.12);
    if (uFaceFinish > 7.5) {
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
    bool flatReleased = uLayer > 0.5 && uLayer < 1.5;
    float released = flatReleased ? 1.0
      : smoothstep(0.02, 0.98, texture2D(uReleaseHistory, vUv).r);
    if (released > 0.0) {
      vec3 releaseColor = vec3(0.21, 0.18, 0.23);
      float releaseAlpha = min(alpha, 0.70 * silhouette);
      if (uReleaseFinish > 2.5) {
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
      color = mix(color, releaseColor, released);
      alpha = mix(alpha, releaseAlpha, released);
    }
    #endif
    if (uDissolve > 0.0) {
      float sweep = 0.5 + dot(vUv - 0.5, uDirection) * 0.6;
      float variation = softNoise(vUv * 7.0) * 0.8 + softNoise(vUv * 21.0) * 0.2;
      float dissolveStart = 0.10 + sweep * 0.42 + variation * 0.15;
      float veil = 1.0 - smoothstep(0.0, 1.0, uDissolve) * 0.35;
      alpha *= veil * (1.0 - smoothstep(dissolveStart, dissolveStart + 0.34, uDissolve));
    }
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
  private readonly raycaster = new THREE.Raycaster();
  private readonly hitPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly stateData: Uint8Array;
  private readonly stateSources: Int32Array;
  private readonly stateTexture: THREE.DataTexture;
  private readonly curlDistances: Uint8Array;
  private readonly curlQueue: Int32Array;
  private readonly curlTexture: THREE.DataTexture;
  private readonly releaseData: Uint8Array;
  private readonly releaseTexture: THREE.DataTexture;
  private lastReleaseRevision = -1;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly stickerMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private readonly dissolves: DissolvingShape[] = [];
  private heldDissolve: DissolvingShape | null = null;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly resizeObserver: ResizeObserver;
  private readonly originalWhiteArtwork: boolean;
  private readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private zoom = 1;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private dragInput: { x: number; y: number; point: Vec2; heading: Vec2; towardEdge: boolean } | null = null;
  private dragReach: { direction: Vec2; scale: number } | null = null;
  private movingRegion: PeelRegion | null = null;
  private movingBounds: PeelBounds | null = null;
  private cameraReady = false;
  private readonly stickerWidth = STICKER_WIDTH;
  private readonly stickerHeight: number;
  private frame = 0;
  private resizeFrame = 0;
  private lastFpsTime = performance.now();
  private fpsFrames = 0;
  // Keep render resolution stable. Reallocating the WebGL drawing buffer mid-gesture
  // caused intermittent single-frame flashes on devices near the FPS thresholds.
  private readonly pixelRatio = Math.min(window.devicePixelRatio, 1.75);
  private disposed = false;
  onFps?: (fps: number) => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly simulation: PeelSimulation,
    artwork: HTMLImageElement,
    artworkAspect: number,
    whiteArtwork = false,
  ) {
    this.originalWhiteArtwork = whiteArtwork;
    this.stickerHeight = this.stickerWidth / artworkAspect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.domElement = this.renderer.domElement;
    this.domElement.className = "peel-canvas";
    this.host.appendChild(this.domElement);

    this.surfaceMaterial = new THREE.MeshStandardMaterial({ map: makeSurfaceTexture(), roughness: 0.88, metalness: 0.04 });
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(22, 18), this.surfaceMaterial);
    surface.position.z = -0.095;
    this.scene.add(surface);
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
    this.curlTexture = new THREE.DataTexture(this.curlDistances, simulation.width, simulation.height, THREE.RedFormat);
    this.curlTexture.minFilter = THREE.LinearFilter;
    this.curlTexture.magFilter = THREE.LinearFilter;
    this.curlTexture.needsUpdate = true;

    this.releaseData = new Uint8Array(simulation.width * simulation.height);
    this.releaseTexture = new THREE.DataTexture(this.releaseData, simulation.width, simulation.height, THREE.RedFormat);
    this.releaseTexture.minFilter = THREE.LinearFilter;
    this.releaseTexture.magFilter = THREE.LinearFilter;
    this.updateReleaseHistory();

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
        uWhiteArtwork: { value: whiteArtwork ? 1 : 0 },
        uStickerColor: { value: new THREE.Color(0xffffff) },
        uFaceFinish: { value: 0 },
        uBackFinish: { value: 0 },
        uReleaseFinish: { value: 0 },
        uState: { value: this.stateTexture },
        uCurlDistances: { value: this.curlTexture },
        uCurlCellSize: { value: Math.min(this.stickerWidth / simulation.width, this.stickerHeight / simulation.height) },
        uReleaseHistory: { value: this.releaseTexture },
        uLayer: { value: pass.layer },
        uFilmColor: { value: new THREE.Color(0xf05fa8) },
        uLiftedOpacity: { value: 0.5 },
        uGrab: { value: new THREE.Vector2(-2.1, 0) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uFrontDepth: { value: 0 },
        uRadius: { value: 0.31 },
        uCone: { value: 0 },
        uStress: { value: 0 },
        uStretch: { value: 0 },
        uRelax: { value: 0 },
        uFlatOffset: { value: new THREE.Vector2() },
        uDissolve: { value: 0 },
        uTornOffset: { value: new THREE.Vector2() },
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
    this.simulation.writeTexture(this.stateData);
    if (this.updateMovingRegion() === Cell.lifted) {
      writeCurlDistances(this.stateData, this.curlDistances, this.simulation.width, this.curlQueue);
      extendStateTexture(this.curlDistances, this.stateSources, 1);
      this.curlTexture.needsUpdate = true;
    }
    extendStateTexture(this.stateData, this.stateSources);
    this.stateTexture.needsUpdate = true;
    this.updateReleaseHistory();
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
    this.simulation.writeReleaseHistory(this.releaseData);
    extendStateTexture(this.releaseData, this.stateSources, 1);
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
      this.movingBounds = {
        x: Math.abs(region.x + offsetX) + region.width / 2,
        y: Math.abs(region.y + offsetY) + region.height / 2,
        z: TORN_LAYER_Z,
      };
    } else if (region && worldDepth > 0) {
      this.movingBounds = { x: 0, y: 0, z: 0 };
      includeCurl(this.movingBounds, region.width, region.height, worldGrab, worldDirection,
        worldDepth, radius, profile === "cone", stretch, region);
    }
    for (const material of this.materials) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uGrab.value.copy(worldGrab);
      uniforms.uDirection.value.copy(worldDirection);
      uniforms.uFrontDepth.value = worldDepth;
      uniforms.uRadius.value = radius;
      uniforms.uCone.value = profile === "cone" ? 1 : 0;
      uniforms.uStress.value = stress;
      uniforms.uStretch.value = stretch;
      uniforms.uTornOffset.value.set(offsetX, offsetY);
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
      const bounds = this.movingBounds;
      const material = back.material.clone();
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
      uniforms.uArt.value = back.material.uniforms.uArt.value;
      uniforms.uReleaseHistory.value = this.releaseTexture;
      uniforms.uState.value = texture;
      uniforms.uCurlDistances.value = this.curlTexture;
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
        bounds.x = Math.max(bounds.x, Math.abs(x - 2 * along * direction.x + flatOffset.x) + (diagonal * width + cross * height) / 2);
        bounds.y = Math.max(bounds.y, Math.abs(y - 2 * along * direction.y + flatOffset.y) + (cross * width + diagonal * height) / 2);
        bounds.z = Math.max(bounds.z, 0.15);
      }
      this.heldDissolve = { texture, mesh, started: performance.now(), origin: { ...pointer },
        offset: { x: 0, y: 0 }, bounds };
      this.dissolves.push(this.heldDissolve);
    }
    const shape = this.heldDissolve;
    shape.offset.x = (pointer.x - shape.origin.x) * this.stickerWidth;
    shape.offset.y = (pointer.y - shape.origin.y) * this.stickerHeight;
    shape.mesh.position.setX(shape.offset.x).setY(shape.offset.y);
  }

  clearDissolves() {
    for (const shape of this.dissolves) this.disposeDissolve(shape);
    this.dissolves.length = 0;
    this.heldDissolve = null;
  }

  private disposeDissolve(shape: DissolvingShape) {
    this.scene.remove(shape.mesh);
    shape.mesh.material.dispose();
    shape.texture.dispose();
  }

  setAppearance(appearance: PeelAppearance) {
    const background = BACKGROUNDS[appearance.background].color;
    this.surfaceMaterial.emissive.set(background);
    this.surfaceMaterial.emissiveIntensity = appearance.background === 0 ? 0 : 0.95;
    this.scene.background = appearance.background === 0 ? null : new THREE.Color(background).multiplyScalar(0.62);

    const sticker = STICKER_COLORS[appearance.sticker].color;
    for (const material of this.materials) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uWhiteArtwork.value = sticker || this.originalWhiteArtwork ? 1 : 0;
      uniforms.uStickerColor.value.set(sticker ?? "#ffffff");
      uniforms.uFaceFinish.value = appearance.face;
      uniforms.uBackFinish.value = appearance.back;
      uniforms.uReleaseFinish.value = appearance.released;
    }
    for (const shape of this.dissolves) {
      shape.mesh.material.uniforms.uBackFinish.value = appearance.back;
      shape.mesh.material.uniforms.uReleaseFinish.value = appearance.released;
    }
  }

  setDebug(enabled: boolean) {
    for (const material of this.materials) material.wireframe = enabled;
  }

  setLiftedTransparency(transparency: number) {
    const opacity = 1 - THREE.MathUtils.clamp(transparency, 0, 0.95);
    for (const material of this.materials) {
      (material.uniforms as unknown as PeelUniforms).uLiftedOpacity.value = opacity;
    }
    for (const shape of this.dissolves) shape.mesh.material.uniforms.uLiftedOpacity.value = opacity;
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

    // Project the grabbed point using the same curl and seam correction as the shader.
    const grab = this.uvToWorld(snapshot.grab);
    const depth = snapshot.frontDepth * this.stickerHeight;
    const radius = curlRadius(profile);
    const length = depth * (1 + tensionStretch(snapshot.stress, snapshot.tearThreshold));
    const theta = Math.min(length / radius, Math.PI);
    const shift = depth + Math.max(length - Math.PI * radius, 0) - radius * Math.sin(theta);
    const rise = 0.018 + radius * (1 - Math.cos(theta));
    const { width, height } = this.simulation;
    const x = THREE.MathUtils.clamp(snapshot.grab.x * width - 0.5, 0, width - 1);
    const y = THREE.MathUtils.clamp(snapshot.grab.y * height - 0.5, 0, height - 1);
    const col = Math.floor(x);
    const row = Math.floor(y) * width;
    const right = Math.min(col + 1, width - 1);
    const above = Math.min(row + width, (height - 1) * width);
    const low = THREE.MathUtils.lerp(this.curlDistances[row + col], this.curlDistances[row + right], x - col);
    const high = THREE.MathUtils.lerp(this.curlDistances[above + col], this.curlDistances[above + right], x - col);
    const cellsFromSeam = THREE.MathUtils.lerp(low, high, y % 1);
    const cellSize = Math.min(this.stickerWidth / width, this.stickerHeight / height);
    const correction = (1 - THREE.MathUtils.smoothstep(cellsFromSeam, 3, 16))
      * Math.min(1, 8 * cellSize / Math.max(Math.hypot(shift, rise), 0.0001));
    const grip = new THREE.Vector3(
      grab.x + snapshot.direction.x * shift * (1 - correction),
      grab.y + snapshot.direction.y * shift * (1 - correction),
      0.004 + rise * (1 - correction),
    ).project(this.camera);
    const rect = this.domElement.getBoundingClientRect();
    const gripX = rect.left + (1 + grip.x) * rect.width / 2;
    const gripY = rect.top + (1 - grip.y) * rect.height / 2;
    return Math.hypot(input.x - gripX, input.y - gripY);
  }

  tornGripContact() {
    const input = this.dragInput;
    return input && this.screenToSticker(input.x, input.y, TORN_LAYER_Z);
  }

  setZoom(zoom: number) {
    this.zoom = zoom;
  }

  beginDrag(clientX: number, clientY: number, point: Vec2) {
    this.dragInput = { x: clientX, y: clientY, point, heading: { x: 0, y: 0 }, towardEdge: false };
  }

  updateDragReach() {
    const input = this.dragInput;
    this.dragReach = null;
    if (!input?.towardEdge) return;
    const bounds = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const reach = this.simulation.remainingPeelTravel();
    if (!reach) return;
    const direction = { x: reach.direction.x, y: -reach.direction.y };
    const scale = dragScaleForReach(input, direction, bounds, reach.distance * this.stickerHeight);
    if (scale > 0) this.dragReach = { direction, scale };
  }

  dragToSticker(clientX: number, clientY: number) {
    const input = this.dragInput;
    if (!input) return null;
    const rect = this.domElement.getBoundingClientRect();
    // Pointer capture lets the player keep peeling across the whole window, including over the HUD.
    const x = THREE.MathUtils.clamp(clientX, 0, window.innerWidth);
    const y = THREE.MathUtils.clamp(clientY, 0, window.innerHeight);
    // Use only physical pointer movement. Reprojecting the same pixel after
    // zooming would move the simulated grip and create tension on its own.
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const unitsPerPixel = 2 * this.camera.position.z * tangent / Math.max(1, rect.height);
    const dx = x - input.x;
    const dy = y - input.y;
    if (dx || dy) {
      input.heading.x = input.heading.x * 0.65 + dx * 0.35;
      input.heading.y = input.heading.y * 0.65 + dy * 0.35;
      input.towardEdge = approachesScreenEdge({ x, y }, { x: dx, y: dy }, input.heading,
        { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight });
    }
    let worldX = dx * unitsPerPixel;
    let worldY = dy * unitsPerPixel;
    if (input.towardEdge && this.dragReach && this.dragReach.scale > unitsPerPixel) {
      // Give the last pixels of real movement extra reach without moving the camera.
      const { direction, scale } = this.dragReach;
      const extra = Math.max(0, dx * direction.x + dy * direction.y) * (scale - unitsPerPixel);
      worldX += extra * direction.x;
      worldY += extra * direction.y;
    }
    input.point = {
      x: input.point.x + worldX / this.stickerWidth,
      y: input.point.y - worldY / this.stickerHeight,
    };
    input.x = x;
    input.y = y;
    return input.point;
  }

  endDrag() {
    this.dragInput = null;
    this.dragReach = null;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver.disconnect();
    this.clearDissolves();
    for (const mesh of this.stickerMeshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.shadow.geometry.dispose();
    this.shadow.material.uniforms.uShadow.value.dispose();
    this.shadow.material.dispose();
    this.stateTexture.dispose();
    this.curlTexture.dispose();
    this.releaseTexture.dispose();
    this.renderer.dispose();
    this.domElement.remove();
  }

  private uvToWorld(point: Vec2) {
    return new THREE.Vector2((point.x - 0.5) * this.stickerWidth, (point.y - 0.5) * this.stickerHeight);
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  private frameCamera() {
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const inset = Math.min(28, Math.min(width, height) * 0.09);
    const rest = fitDistance({ x: this.stickerWidth / 2, y: this.stickerHeight / 2, z: 0.022 }, tangent, width, height, inset);
    const fit = (margin: number) => Math.max(
      this.movingBounds ? fitDistance(this.movingBounds, tangent, width, height, margin) : 0,
      ...this.dissolves.map(shape => shape.bounds ? fitDistance({
        x: shape.bounds.x + Math.abs(shape.offset.x),
        y: shape.bounds.y + Math.abs(shape.offset.y),
        z: shape.bounds.z,
      }, tangent, width, height, margin) : 0),
    );
    const base = rest * 1.04 / this.zoom;
    const towardEdge = this.dragInput?.towardEdge;
    const target = towardEdge ? Math.max(fit(inset), base) : base;
    const guard = towardEdge ? fit(Math.min(inset, 8)) : 0;
    const distance = this.cameraReady ? stepCameraDistance(this.camera.position.z, target, guard) : target;
    this.cameraReady = true;
    this.camera.position.z = distance;
    const far = Math.max(40, distance * 2 + 2);
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const phase = this.dissolves.length ? "dissolve" : this.dragInput ? "drag" : "idle";
    for (let i = this.dissolves.length - 1; i >= 0; i--) {
      const shape = this.dissolves[i];
      const elapsed = now - shape.started;
      if (elapsed >= RELAX_MS + DISSOLVE_MS) {
        this.disposeDissolve(shape);
        this.dissolves.splice(i, 1);
      } else {
        const relax = THREE.MathUtils.smoothstep(elapsed, 0, RELAX_MS);
        const dissolve = Math.max(0, (elapsed - RELAX_MS) / DISSOLVE_MS);
        shape.mesh.material.uniforms.uRelax.value = relax;
        shape.mesh.material.uniforms.uDissolve.value = dissolve;
      }
    }
    const cameraStarted = performance.now();
    this.frameCamera();
    const renderStarted = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.frameTimings.recordFrame(now, {
      phase,
      visible: document.visibilityState === "visible",
      animationMs: cameraStarted - now,
      cameraMs: renderStarted - cameraStarted,
      renderSubmitMs: performance.now() - renderStarted,
    });
    this.fpsFrames++;
    if (now - this.lastFpsTime > 650) {
      const fps = Math.round(this.fpsFrames * 1000 / (now - this.lastFpsTime));
      this.onFps?.(fps);
      this.fpsFrames = 0;
      this.lastFpsTime = now;
    }
  };
}
