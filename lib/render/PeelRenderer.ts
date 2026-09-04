import * as THREE from "three";
import type { CurlProfile, PeelSimulation, Vec2 } from "../peel/PeelSimulation";

const STICKER_WIDTH = 4.8;

type PeelUniforms = {
  uArt: { value: THREE.Texture };
  uBack: { value: THREE.Texture };
  uState: { value: THREE.DataTexture };
  uLayer: { value: number };
  uGrab: { value: THREE.Vector2 };
  uPointer: { value: THREE.Vector2 };
  uDirection: { value: THREE.Vector2 };
  uFrontDepth: { value: number };
  uRadius: { value: number };
  uCone: { value: number };
  uStress: { value: number };
};

const vertexShader = /* glsl */ `
  precision highp float;
  uniform vec2 uGrab;
  uniform vec2 uPointer;
  uniform vec2 uDirection;
  uniform float uFrontDepth;
  uniform float uRadius;
  uniform float uCone;
  uniform float uLayer;
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

    if (uLayer > 1.5 && q > 0.0) {
      float coneScale = mix(1.0, clamp(1.0 + lateral * 0.24, 0.58, 1.46), uCone);
      float radius = max(0.12, uRadius * coneScale);
      float theta = min(q / radius, PI);
      float extra = max(q - PI * radius, 0.0);
      vec2 front = uGrab + direction * uFrontDepth + lateralAxis * lateral;
      vec2 curled = front - direction * (radius * sin(theta)) + direction * extra;
      float z = radius * (1.0 - cos(theta));

      float grabTheta = min(uFrontDepth / radius, PI);
      float grabExtra = max(uFrontDepth - PI * radius, 0.0);
      vec2 nominalGrab = uGrab + direction * uFrontDepth
        - direction * (radius * sin(grabTheta)) + direction * grabExtra;
      float gripWeight = smoothstep(0.0, max(uFrontDepth, 0.001), q);
      curled += (uPointer - nominalGrab) * gripWeight * gripWeight;
      curled += lateralAxis * (-lateral * 0.05 * uCone * gripWeight);

      p.xy = curled;
      p.z = z + gripWeight * 0.035;
      vNormalWorld = normalize(vec3(direction * sin(theta), cos(theta)));
      vCurl = smoothstep(0.0, PI, theta);
    } else if (uLayer > 0.5) {
      p.z += 0.018;
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uArt;
  uniform sampler2D uBack;
  uniform sampler2D uState;
  uniform float uLayer;
  uniform float uStress;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;

  void main() {
    vec4 state = texture2D(uState, vUv);
    float layerMask = uLayer < 0.5 ? state.r : (uLayer < 1.5 ? state.g : state.b);
    if (layerMask < 0.32 || state.a < 0.2) discard;
    vec4 frontInk = texture2D(uArt, vUv);
    vec4 backPaper = texture2D(uBack, vUv);
    vec4 ink = gl_FrontFacing ? frontInk : backPaper;
    if (ink.a < 0.04) discard;

    vec3 normal = normalize(gl_FrontFacing ? vNormalWorld : -vNormalWorld);
    vec3 lightDirection = normalize(vec3(-0.38, 0.55, 0.74));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float grazing = pow(1.0 - abs(normal.z), 2.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
    vec3 color = ink.rgb * (0.61 + diffuse * 0.43);
    color += vec3(0.48, 0.40, 0.56) * grazing * 0.15 + specular * 0.22;
    color = mix(color, vec3(1.0, 0.52, 0.66), uStress * vCurl * 0.12);
    gl_FragColor = vec4(color, ink.a);
  }
`;

function makeArtTexture(image: HTMLImageElement) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function makeBackTexture() {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const paper = context.createLinearGradient(100, 80, 900, 940);
  paper.addColorStop(0, "#fffdf8");
  paper.addColorStop(0.5, "#e7dfd4");
  paper.addColorStop(1, "#c9bcad");
  context.fillStyle = paper;
  context.fillRect(0, 0, size, size);
  context.globalAlpha = 0.16;
  context.strokeStyle = "#83776b";
  context.lineWidth = 2;
  for (let y = 24; y < size; y += 15) {
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(260, y + 12, 720, y - 11, size, y + 4);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
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
  private readonly stateTexture: THREE.DataTexture;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly stickerMeshes: THREE.Mesh[] = [];
  private readonly shadow: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly stickerWidth = STICKER_WIDTH;
  private readonly stickerHeight: number;
  private frame = 0;
  private resizeFrame = 0;
  private lastFpsTime = performance.now();
  private fpsFrames = 0;
  private pixelRatio = Math.min(window.devicePixelRatio, 2);
  private disposed = false;
  onFps?: (fps: number) => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly simulation: PeelSimulation,
    artwork: HTMLImageElement,
    artworkAspect: number,
  ) {
    this.stickerHeight = this.stickerWidth / artworkAspect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.domElement = this.renderer.domElement;
    this.domElement.className = "peel-canvas";
    this.host.appendChild(this.domElement);

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 18),
      new THREE.MeshStandardMaterial({ map: makeSurfaceTexture(), roughness: 0.88, metalness: 0.04 }),
    );
    surface.position.z = -0.095;
    this.scene.add(surface);
    this.scene.add(new THREE.HemisphereLight(0xa799bd, 0x17141b, 1.2));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.55);
    key.position.set(-3.5, 4.5, 7);
    this.scene.add(key);

    this.stateData = new Uint8Array(simulation.width * simulation.height * 4);
    simulation.writeTexture(this.stateData);
    this.stateTexture = new THREE.DataTexture(this.stateData, simulation.width, simulation.height, THREE.RGBAFormat);
    this.stateTexture.minFilter = THREE.LinearFilter;
    this.stateTexture.magFilter = THREE.LinearFilter;
    this.stateTexture.needsUpdate = true;

    const art = makeArtTexture(artwork);
    const back = makeBackTexture();
    const geometry = new THREE.PlaneGeometry(this.stickerWidth, this.stickerHeight, 124, 100);
    for (let layer = 0; layer < 3; layer++) {
      const uniforms: PeelUniforms = {
        uArt: { value: art },
        uBack: { value: back },
        uState: { value: this.stateTexture },
        uLayer: { value: layer },
        uGrab: { value: new THREE.Vector2(-2.1, 0) },
        uPointer: { value: new THREE.Vector2(-2.1, 0) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uFrontDepth: { value: 0 },
        uRadius: { value: 0.31 },
        uCone: { value: 0 },
        uStress: { value: 0 },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: true,
        depthTest: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = layer;
      mesh.position.z = layer * 0.002;
      this.materials.push(material);
      this.stickerMeshes.push(mesh);
      this.scene.add(mesh);
    }

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(this.stickerWidth * 1.14, this.stickerHeight * 1.14),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(artwork), transparent: true, opacity: 0.38, depthWrite: false }),
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
    this.stateTexture.needsUpdate = true;
  }

  setPeel(grab: Vec2, pointer: Vec2, direction: Vec2, depth: number, profile: CurlProfile, stress: number) {
    const worldGrab = this.uvToWorld(grab);
    const worldPointer = this.uvToWorld(pointer);
    const worldDirection = new THREE.Vector2(direction.x, direction.y).normalize();
    const worldDepth = depth * this.stickerHeight;
    for (const material of this.materials) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uGrab.value.copy(worldGrab);
      uniforms.uPointer.value.copy(worldPointer);
      uniforms.uDirection.value.copy(worldDirection);
      uniforms.uFrontDepth.value = worldDepth;
      uniforms.uRadius.value = profile === "cone" ? 0.28 : 0.32;
      uniforms.uCone.value = profile === "cone" ? 1 : 0;
      uniforms.uStress.value = stress;
    }
    const lift = Math.min(1, depth * 2.2);
    this.shadow.scale.set(1 + lift * 0.08, 1 + lift * 0.12, 1);
    this.shadow.position.set(-direction.x * lift * 0.08 + 0.06, -direction.y * lift * 0.08 - 0.08, -0.055);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 + lift * 0.18;
  }

  setDebug(enabled: boolean) {
    for (const material of this.materials) material.wireframe = enabled;
  }

  screenToSticker(clientX: number, clientY: number): Vec2 | null {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.hitPlane, point)) return null;
    return { x: point.x / this.stickerWidth + 0.5, y: point.y / this.stickerHeight + 0.5 };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver.disconnect();
    for (const mesh of this.stickerMeshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.stateTexture.dispose();
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
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const margin = width < 680 ? 1.14 : 1.09;
    const verticalDistance = this.stickerHeight * 0.5 * margin / tangent;
    const horizontalDistance = this.stickerWidth * 0.5 * margin / (tangent * this.camera.aspect);
    this.camera.position.set(0, 0, Math.max(verticalDistance, horizontalDistance));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.lastFpsTime > 650) {
      const fps = Math.round(this.fpsFrames * 1000 / (now - this.lastFpsTime));
      this.onFps?.(fps);
      const ceiling = Math.min(window.devicePixelRatio, 2);
      if (fps < 46 && this.pixelRatio > 1) {
        this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.resize();
      } else if (fps > 58 && this.pixelRatio < ceiling) {
        this.pixelRatio = Math.min(ceiling, this.pixelRatio + 0.1);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.resize();
      }
      this.fpsFrames = 0;
      this.lastFpsTime = now;
    }
  };
}
