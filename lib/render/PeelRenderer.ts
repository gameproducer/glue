import * as THREE from "three";
import type { CurlProfile, PeelSimulation, Vec2 } from "../peel/PeelSimulation";

const STICKER_WIDTH = 4.1;
const STICKER_HEIGHT = 3.76;

type PeelUniforms = {
  uArt: { value: THREE.Texture };
  uBack: { value: THREE.Texture };
  uState: { value: THREE.DataTexture };
  uLayer: { value: number };
  uGrab: { value: THREE.Vector2 };
  uInward: { value: THREE.Vector2 };
  uDepth: { value: number };
  uRadius: { value: number };
  uCone: { value: number };
  uStress: { value: number };
};

const vertexShader = /* glsl */ `
  precision highp float;
  uniform vec2 uGrab;
  uniform vec2 uInward;
  uniform float uDepth;
  uniform float uRadius;
  uniform float uCone;
  uniform float uLayer;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying float vCurl;

  void main() {
    vUv = uv;
    vec3 p = position;
    vec2 inward = normalize(uInward);
    vec2 lateralAxis = vec2(-inward.y, inward.x);
    vec2 relative = p.xy - uGrab;
    float s = dot(relative, inward);
    float lateral = dot(relative, lateralAxis);
    float q = max(uDepth - s, 0.0);
    vCurl = 0.0;
    vNormalWorld = vec3(0.0, 0.0, 1.0);

    if (uLayer > 1.5 && q > 0.0) {
      float coneScale = mix(1.0, clamp(1.0 + lateral * 0.22, 0.56, 1.48), uCone);
      float radius = max(0.12, uRadius * coneScale);
      float cap = 2.42;
      float theta = min(q / radius, cap);
      float arcLength = theta * radius;
      float extra = max(q - arcLength, 0.0);
      vec2 front = uGrab + inward * uDepth;
      vec2 curled = front - inward * (radius * sin(theta));
      curled += lateralAxis * lateral;
      curled += -inward * cos(theta) * extra;
      float gripWeight = smoothstep(0.0, max(uDepth, 0.001), q);
      curled += -inward * uDepth * 0.22 * gripWeight;
      p.xy = curled;
      p.z = radius * (1.0 - cos(theta)) + sin(theta) * extra;
      vec3 alongQ = vec3(-inward * cos(theta), sin(theta));
      vec3 alongLateral = vec3(lateralAxis, uCone * 0.035 * sin(theta));
      vNormalWorld = normalize(cross(alongLateral, alongQ));
      vCurl = smoothstep(0.0, cap, theta);
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
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
    vec3 color = ink.rgb * (0.61 + diffuse * 0.43);
    color += vec3(0.42, 0.32, 0.50) * grazing * 0.16 + specular * 0.2;
    color = mix(color, vec3(1.0, 0.22, 0.28), uStress * vCurl * 0.16);
    gl_FragColor = vec4(color, ink.a);
  }
`;

function makeStickerArt(back = false) {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const shape = new Path2D();
  shape.moveTo(512, 84);
  shape.bezierCurveTo(662, 58, 786, 143, 814, 270);
  shape.bezierCurveTo(951, 324, 955, 507, 834, 592);
  shape.bezierCurveTo(825, 751, 671, 891, 514, 803);
  shape.bezierCurveTo(350, 902, 181, 758, 194, 596);
  shape.bezierCurveTo(67, 514, 76, 326, 212, 275);
  shape.bezierCurveTo(247, 137, 370, 58, 512, 84);
  shape.closePath();

  context.save();
  context.clip(shape);
  if (back) {
    const paper = context.createLinearGradient(120, 80, 850, 930);
    paper.addColorStop(0, "#fffdf5");
    paper.addColorStop(0.48, "#e8e0d4");
    paper.addColorStop(1, "#cfc3b3");
    context.fillStyle = paper;
    context.fillRect(0, 0, size, size);
    context.globalAlpha = 0.2;
    context.strokeStyle = "#8d8173";
    context.lineWidth = 2;
    for (let y = 30; y < size; y += 15) {
      context.beginPath();
      context.moveTo(0, y);
      context.bezierCurveTo(260, y + 14, 720, y - 12, size, y + 5);
      context.stroke();
    }
  } else {
    const base = context.createLinearGradient(96, 110, 918, 880);
    base.addColorStop(0, "#ff315d");
    base.addColorStop(0.28, "#ff9e2c");
    base.addColorStop(0.54, "#23c8cd");
    base.addColorStop(0.77, "#376de0");
    base.addColorStop(1, "#9a39dd");
    context.fillStyle = base;
    context.fillRect(0, 0, size, size);

    context.globalAlpha = 0.72;
    context.fillStyle = "#f02477";
    context.beginPath(); context.ellipse(256, 570, 305, 235, -0.38, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#ffd337";
    context.beginPath(); context.ellipse(720, 252, 270, 185, 0.3, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#42e0c3";
    context.beginPath(); context.ellipse(670, 720, 290, 220, -0.22, 0, Math.PI * 2); context.fill();
    context.globalAlpha = 0.24;
    context.strokeStyle = "#ffffff";
    context.lineWidth = 18;
    for (let x = -500; x < 1500; x += 92) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 650, size);
      context.stroke();
    }
    context.globalAlpha = 0.18;
    context.lineWidth = 7;
    for (let radius = 90; radius < 700; radius += 54) {
      context.beginPath();
      context.arc(512, 490, radius, -2.8, 0.8);
      context.stroke();
    }
  }
  context.restore();

  context.globalCompositeOperation = "destination-out";
  context.beginPath(); context.ellipse(334, 370, 61, 86, -0.12, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.ellipse(690, 370, 61, 86, 0.12, 0, Math.PI * 2); context.fill();
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = back ? "rgba(103,92,77,.65)" : "rgba(255,255,255,.92)";
  context.lineWidth = 18;
  context.stroke(shape);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
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
  for (let i = 0; i < 11000; i++) {
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

function makeShadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(256, 128, 4, 256, 128, 230);
  gradient.addColorStop(0, "rgba(0,0,0,.58)");
  gradient.addColorStop(0.55, "rgba(0,0,0,.22)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 256);
  return new THREE.CanvasTexture(canvas);
}

export class PeelRenderer {
  readonly domElement: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(31, 1, 0.1, 30);
  private readonly raycaster = new THREE.Raycaster();
  private readonly hitPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly stateData: Uint8Array;
  private readonly stateTexture: THREE.DataTexture;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly stickerMeshes: THREE.Mesh[] = [];
  private readonly shadow: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private resizeFrame = 0;
  private lastFpsTime = performance.now();
  private fpsFrames = 0;
  private pixelRatio = Math.min(window.devicePixelRatio, 2);
  private disposed = false;
  onFps?: (fps: number) => void;

  constructor(private readonly host: HTMLElement, private readonly simulation: PeelSimulation) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.domElement = this.renderer.domElement;
    this.domElement.className = "peel-canvas";
    this.host.appendChild(this.domElement);

    this.camera.position.set(0, -0.35, 7.25);
    this.camera.lookAt(0, 0, 0);

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 10),
      new THREE.MeshStandardMaterial({ map: makeSurfaceTexture(), roughness: 0.88, metalness: 0.04 }),
    );
    surface.position.z = -0.095;
    this.scene.add(surface);
    this.scene.add(new THREE.HemisphereLight(0x9c90ba, 0x17141b, 1.25));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.5);
    key.position.set(-3.5, 4.5, 7);
    this.scene.add(key);

    this.stateData = new Uint8Array(simulation.width * simulation.height * 4);
    simulation.writeTexture(this.stateData);
    this.stateTexture = new THREE.DataTexture(this.stateData, simulation.width, simulation.height, THREE.RGBAFormat);
    this.stateTexture.minFilter = THREE.NearestFilter;
    this.stateTexture.magFilter = THREE.NearestFilter;
    this.stateTexture.needsUpdate = true;

    const art = makeStickerArt(false);
    const back = makeStickerArt(true);
    const geometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_HEIGHT, 100, 92);
    for (let layer = 0; layer < 3; layer++) {
      const uniforms: PeelUniforms = {
        uArt: { value: art },
        uBack: { value: back },
        uState: { value: this.stateTexture },
        uLayer: { value: layer },
        uGrab: { value: new THREE.Vector2(1.5, 0) },
        uInward: { value: new THREE.Vector2(-1, 0) },
        uDepth: { value: 0 },
        uRadius: { value: 0.38 },
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
      new THREE.PlaneGeometry(4.6, 2.8),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.position.set(0.12, -0.14, -0.06);
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

  setPeel(grab: Vec2, inward: Vec2, depth: number, profile: CurlProfile, stress: number) {
    const worldGrab = this.uvToWorld(grab);
    const direction = new THREE.Vector2(inward.x * STICKER_WIDTH, inward.y * STICKER_HEIGHT).normalize();
    const worldDepth = depth * Math.max(STICKER_WIDTH, STICKER_HEIGHT);
    for (const material of this.materials) {
      const uniforms = material.uniforms as unknown as PeelUniforms;
      uniforms.uGrab.value.set(worldGrab.x, worldGrab.y);
      uniforms.uInward.value.copy(direction);
      uniforms.uDepth.value = worldDepth;
      uniforms.uRadius.value = profile === "cone" ? 0.34 : 0.39;
      uniforms.uCone.value = profile === "cone" ? 1 : 0;
      uniforms.uStress.value = stress;
    }
    const lift = Math.min(1, depth * 1.5);
    this.shadow.scale.set(1 + lift * 0.2, 1 + lift * 0.55, 1);
    this.shadow.position.set(0.12 + inward.x * -lift * 0.2, -0.14 + inward.y * -lift * 0.2, -0.06);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.2 + lift * 0.22;
  }

  setDebug(enabled: boolean) {
    for (const material of this.materials) material.wireframe = enabled;
  }

  screenToSticker(clientX: number, clientY: number): Vec2 | null {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.hitPlane, point)) return null;
    return { x: point.x / STICKER_WIDTH + 0.5, y: point.y / STICKER_HEIGHT + 0.5 };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver.disconnect();
    for (const mesh of this.stickerMeshes) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.stateTexture.dispose();
    this.renderer.dispose();
    this.domElement.remove();
  }

  private uvToWorld(point: Vec2) {
    return new THREE.Vector2((point.x - 0.5) * STICKER_WIDTH, (point.y - 0.5) * STICKER_HEIGHT);
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const compact = width < 620;
    this.camera.position.z = compact ? 8.25 : 7.25;
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
