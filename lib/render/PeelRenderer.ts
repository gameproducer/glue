import * as THREE from "three";
import { BACKGROUNDS, STICKER_COLORS, type PeelAppearance } from "./PeelAppearance";
import { fitDistance, includeCurl, MAX_TENSION_STRETCH, outwardEdgePressure, stepCameraDistance, type PeelBounds, type PeelRegion } from "./PeelFraming";
import { nearestStateSources, extendStateTexture } from "./StateTexture";
import { Cell, type CurlProfile, type PeelSimulation, type Vec2 } from "../peel/PeelSimulation";

const STICKER_WIDTH = 4.8;
const RELAX_MS = 420;
const DISSOLVE_MS = 1800;

type DissolvingShape = {
  texture: THREE.DataTexture;
  meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
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
    vCurl = 0.0;
    vNormalWorld = vec3(0.0, 0.0, 1.0);

    if (uLayer > 2.5) {
      p.xy += uTornOffset;
      p.z += 0.08;
    } else if (uLayer > 1.5 && q > 0.0) {
      q *= 1.0 + uStretch;
      float coneScale = mix(1.0, clamp(1.0 + lateral * 0.24, 0.58, 1.46), uCone);
      float radius = max(0.12, uRadius * coneScale);
      float theta = min(q / radius, PI);
      float extra = max(q - PI * radius, 0.0);
      vec2 front = uGrab + direction * uFrontDepth + lateralAxis * lateral;
      p.xy = front + direction * (extra - radius * sin(theta));
      p.z = 0.018 + radius * (1.0 - cos(theta));
      float relaxedTheta = theta * (1.0 - uRelax);
      vNormalWorld = vec3(direction * sin(relaxedTheta), cos(relaxedTheta));
      vCurl = smoothstep(0.0, PI, relaxedTheta);
    } else if (uLayer > 0.5) {
      p.z += 0.018;
    }
    p = mix(p, vec3(position.xy + uFlatOffset, 0.14), uRelax);
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
    vec3 lightDirection = normalize(vec3(-0.38, 0.55, 0.74));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float grazing = pow(1.0 - abs(normal.z), 2.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
    #ifdef PEEL_BACK_FACE
    vec3 filmColor = uFilmColor * (0.78 + diffuse * 0.14);
    filmColor += vec3(1.0, 0.82, 0.92) * (grazing * 0.18 + specular * 0.24);
    filmColor = mix(filmColor, vec3(1.0, 0.28, 0.52), uStress * vCurl * 0.12);
    float filmAlpha = silhouette * uLiftedOpacity * mix(0.92, 1.0, grazing);
    if (uBackFinish > 2.5) {
      vec2 grid = abs(fract(vUv * 56.0) - 0.5);
      float thread = 1.0 - smoothstep(0.06, 0.19, min(grid.x, grid.y));
      filmColor = mix(filmColor, vec3(0.68, 0.94, 0.9), thread * 0.75);
      filmAlpha *= 0.4 + thread * 0.6;
    } else if (uBackFinish > 1.5) {
      vec3 prism = spectrum((vUv.x - vUv.y * 0.63) * 13.0 + vCurl * 5.0);
      filmColor = mix(filmColor, prism, 0.73);
      filmAlpha *= 0.72 + grazing * 0.28;
    } else if (uBackFinish > 0.5) {
      float speckle = grain(floor(vUv * 430.0));
      filmColor = vec3(0.57, 0.72, 0.83) + vec3(speckle * 0.17 + grazing * 0.12);
      filmAlpha *= 0.76 + speckle * 0.24;
    }
    vec3 color = filmColor;
    float alpha = filmAlpha;
    #else
    vec3 artworkColor = mix(texture2D(uArt, vUv).rgb, uStickerColor, uWhiteArtwork);
    vec3 printedColor = artworkColor * (0.61 + diffuse * 0.43);
    printedColor += vec3(0.48, 0.40, 0.56) * grazing * 0.15 + specular * 0.22;
    printedColor = mix(printedColor, vec3(1.0, 0.52, 0.66), uStress * vCurl * 0.12);
    if (uFaceFinish > 2.5) {
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

    #endif

    // The flat released layer already gets its coverage from state.g. Applying
    // the history mask again there weakens the finish at the feathered edge.
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
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(31, 1, 0.1, 40);
  private readonly raycaster = new THREE.Raycaster();
  private readonly hitPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly stateData: Uint8Array;
  private readonly stateSources: Int32Array;
  private readonly stateTexture: THREE.DataTexture;
  private readonly releaseData: Uint8Array;
  private readonly releaseTexture: THREE.DataTexture;
  private lastReleaseRevision = -1;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly stickerMeshes: THREE.Mesh[] = [];
  private readonly dissolves: DissolvingShape[] = [];
  private heldDissolve: DissolvingShape | null = null;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly resizeObserver: ResizeObserver;
  private readonly originalWhiteArtwork: boolean;
  private readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private dragFit = 0;
  private zoom = 1;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private edgePressure = 0;
  private dragInput: { x: number; y: number; point: Vec2; edgeDistance: number; moving: boolean } | null = null;
  private liftedRegion: PeelRegion | null = null;
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
    this.updateLiftedRegion();
    extendStateTexture(this.stateData, this.stateSources);
    this.stateTexture.needsUpdate = true;
    this.updateReleaseHistory();
  }

  private updateLiftedRegion() {
    const { width, height, state } = this.simulation;
    let left = width, right = -1, bottom = height, top = -1;
    for (let index = 0; index < state.length; index++) {
      if (state[index] !== Cell.lifted) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
    }
    if (right < 0) {
      this.liftedRegion = null;
      return;
    }
    // Include the neighboring texels and mesh triangles along the feathered edge.
    const padX = 2 / width + 1 / 124;
    const padY = 2 / height + 1 / 100;
    const minX = Math.max(0, left / width - padX);
    const maxX = Math.min(1, (right + 1) / width + padX);
    const minY = Math.max(0, bottom / height - padY);
    const maxY = Math.min(1, (top + 1) / height + padY);
    this.liftedRegion = {
      x: ((minX + maxX) / 2 - 0.5) * this.stickerWidth,
      y: ((minY + maxY) / 2 - 0.5) * this.stickerHeight,
      width: (maxX - minX) * this.stickerWidth,
      height: (maxY - minY) * this.stickerHeight,
    };
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
    const radius = profile === "cone" ? 0.28 : 0.32;
    const strain = tearThreshold > 0 ? THREE.MathUtils.smoothstep(stress / tearThreshold, 0.9, 1) : 0;
    const stretch = MAX_TENSION_STRETCH * strain;
    const offsetX = tornOffset.x * this.stickerWidth;
    const offsetY = tornOffset.y * this.stickerHeight;
    this.movingBounds = null;
    if (torn) {
      this.movingBounds = {
        x: this.stickerWidth / 2 + Math.abs(offsetX),
        y: this.stickerHeight / 2 + Math.abs(offsetY),
        z: 0.086,
      };
    } else if (this.liftedRegion && worldDepth > 0) {
      const region = this.liftedRegion;
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
      const { width, height } = this.simulation;
      const data = new Uint8Array(width * height * 4);
      this.simulation.writeDetachedTexture(data);
      extendStateTexture(data, this.stateSources);
      const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      const meshes: DissolvingShape["meshes"] = [];
      const bounds = this.movingBounds;
      for (const [index, source] of this.materials.entries()) {
        if (source.uniforms.uLayer.value !== 2) continue;
        const material = source.clone();
        const uniforms = material.uniforms as unknown as PeelUniforms;
        // Match the curled position at the grab so the sheet opens around the player's grip.
        const depth = uniforms.uFrontDepth.value;
        const radius = uniforms.uRadius.value;
        const length = depth * (1 + uniforms.uStretch.value);
        const theta = Math.min(length / radius, Math.PI);
        const shift = depth + Math.max(length - Math.PI * radius, 0) - radius * Math.sin(theta);
        const flatOffset = uniforms.uFlatOffset.value.copy(uniforms.uDirection.value).multiplyScalar(shift);
        material.uniforms.uArt.value = source.uniforms.uArt.value;
        material.uniforms.uReleaseHistory.value = this.releaseTexture;
        material.uniforms.uState.value = texture;
        material.depthWrite = false;
        const mesh = new THREE.Mesh(this.stickerMeshes[index].geometry, material);
        mesh.renderOrder = this.stickerMeshes[index].renderOrder + 6;
        mesh.position.z = this.stickerMeshes[index].position.z;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        meshes.push(mesh);
        if (bounds && this.liftedRegion) {
          const { x, y, width, height } = this.liftedRegion;
          bounds.x = Math.max(bounds.x, Math.abs(x + flatOffset.x) + width / 2);
          bounds.y = Math.max(bounds.y, Math.abs(y + flatOffset.y) + height / 2);
          bounds.z = Math.max(bounds.z, 0.15);
        }
      }
      this.heldDissolve = { texture, meshes, started: performance.now(), origin: { ...pointer },
        offset: { x: 0, y: 0 }, bounds };
      this.dissolves.push(this.heldDissolve);
    }
    const shape = this.heldDissolve;
    shape.offset.x = (pointer.x - shape.origin.x) * this.stickerWidth;
    shape.offset.y = (pointer.y - shape.origin.y) * this.stickerHeight;
    for (const mesh of shape.meshes) mesh.position.setX(shape.offset.x).setY(shape.offset.y);
  }

  clearDissolves() {
    for (const shape of this.dissolves) this.disposeDissolve(shape);
    this.dissolves.length = 0;
    this.heldDissolve = null;
  }

  private disposeDissolve(shape: DissolvingShape) {
    for (const mesh of shape.meshes) {
      this.scene.remove(mesh);
      mesh.material.dispose();
    }
    shape.meshes.length = 0;
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
      for (const mesh of shape.meshes) mesh.material.uniforms.uReleaseFinish.value = appearance.released;
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
  }

  screenToSticker(clientX: number, clientY: number): Vec2 | null {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.hitPlane, point)) return null;
    return { x: point.x / this.stickerWidth + 0.5, y: point.y / this.stickerHeight + 0.5 };
  }

  setZoom(zoom: number) {
    this.zoom = zoom;
  }

  beginDrag(clientX: number, clientY: number, point: Vec2) {
    this.dragInput = { x: clientX, y: clientY, point, edgeDistance: this.distanceToEdge(clientX, clientY), moving: false };
  }

  dragToSticker(clientX: number, clientY: number) {
    const input = this.dragInput;
    if (!input) return null;
    const rect = this.domElement.getBoundingClientRect();
    const x = THREE.MathUtils.clamp(clientX, Math.max(0, rect.left), Math.min(window.innerWidth, rect.right));
    const y = THREE.MathUtils.clamp(clientY, Math.max(0, rect.top), Math.min(window.innerHeight, rect.bottom));
    input.moving ||= x !== input.x || y !== input.y;
    this.edgePressure = outwardEdgePressure(this.distanceToEdge(x, y, rect), input.edgeDistance);
    // Use only physical pointer movement. Reprojecting the same pixel after
    // zooming would move the simulated grip and create tension on its own.
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const unitsPerPixel = 2 * this.camera.position.z * tangent / Math.max(1, rect.height);
    input.point = {
      x: input.point.x + (x - input.x) * unitsPerPixel / this.stickerWidth,
      y: input.point.y - (y - input.y) * unitsPerPixel / this.stickerHeight,
    };
    input.x = x;
    input.y = y;
    return input.point;
  }

  private distanceToEdge(x: number, y: number, rect = this.domElement.getBoundingClientRect()) {
    return Math.max(0, Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y,
      x, window.innerWidth - x, y, window.innerHeight - y));
  }

  endDrag() {
    this.dragInput = null;
    this.edgePressure = 0;
    this.dragFit = 0;
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
    const heldPoint = this.dragInput?.moving ? this.uvToWorld(this.dragInput.point) : null;
    const gripBounds = heldPoint ? { x: Math.abs(heldPoint.x), y: Math.abs(heldPoint.y), z: 0 } : null;
    const fit = (margin: number) => Math.max(
      this.movingBounds ? fitDistance(this.movingBounds, tangent, width, height, margin) : 0,
      gripBounds ? fitDistance(gripBounds, tangent, width, height, margin) : 0,
      ...this.dissolves.map(shape => shape.bounds ? fitDistance({
        x: shape.bounds.x + Math.abs(shape.offset.x),
        y: shape.bounds.y + Math.abs(shape.offset.y),
        z: shape.bounds.z,
      }, tangent, width, height, margin) : 0),
    );
    const required = fit(inset);
    if (heldPoint) this.dragFit = Math.max(this.dragFit, required);
    const target = Math.max(required, this.dragFit, rest * 1.04 / this.zoom * (1 + 0.45 * this.edgePressure));
    const guard = fit(Math.min(inset, 8));
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
    for (let i = this.dissolves.length - 1; i >= 0; i--) {
      const shape = this.dissolves[i];
      const elapsed = now - shape.started;
      if (elapsed >= RELAX_MS + DISSOLVE_MS) {
        this.disposeDissolve(shape);
        this.dissolves.splice(i, 1);
      } else {
        const relax = THREE.MathUtils.smoothstep(elapsed, 0, RELAX_MS);
        const dissolve = Math.max(0, (elapsed - RELAX_MS) / DISSOLVE_MS);
        for (const mesh of shape.meshes) {
          mesh.material.uniforms.uRelax.value = relax;
          mesh.material.uniforms.uDissolve.value = dissolve;
        }
      }
    }
    this.frameCamera();
    this.renderer.render(this.scene, this.camera);
    this.fpsFrames++;
    if (now - this.lastFpsTime > 650) {
      const fps = Math.round(this.fpsFrames * 1000 / (now - this.lastFpsTime));
      this.onFps?.(fps);
      this.fpsFrames = 0;
      this.lastFpsTime = now;
    }
  };
}
