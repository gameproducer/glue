import * as THREE from "three";
import type { CurlProfile, PeelSimulation, Vec2 } from "../peel/PeelSimulation";

const STICKER_WIDTH = 4.8;
export type LensProfile = "clear" | "bubble" | "prismatic";

type PeelUniforms = {
  uArt: { value: THREE.Texture };
  uScene: { value: THREE.Texture };
  uState: { value: THREE.DataTexture };
  uLayer: { value: number };
  uIor: { value: number };
  uMagnification: { value: number };
  uDispersion: { value: number };
  uLensTint: { value: THREE.Color };
  uScreenAspect: { value: number };
  uGrab: { value: THREE.Vector2 };
  uPointer: { value: THREE.Vector2 };
  uDirection: { value: THREE.Vector2 };
  uFrontDepth: { value: number };
  uRadius: { value: number };
  uCone: { value: number };
  uStress: { value: number };
  uTornOffset: { value: THREE.Vector2 };
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
  uniform vec2 uTornOffset;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vNormalView;
  varying vec3 vViewRay;
  varying vec2 vScreenUv;
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

    if (uLayer > 2.5) {
      p.xy += uTornOffset;
    }

    vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
    vec4 clipPosition = projectionMatrix * viewPosition;
    vViewRay = viewPosition.xyz;
    vNormalView = normalize(normalMatrix * vNormalWorld);
    vScreenUv = clipPosition.xy / clipPosition.w * 0.5 + 0.5;
    gl_Position = clipPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uArt;
  uniform sampler2D uScene;
  uniform sampler2D uState;
  uniform float uLayer;
  uniform float uIor;
  uniform float uMagnification;
  uniform float uDispersion;
  uniform vec3 uLensTint;
  uniform float uScreenAspect;
  uniform float uStress;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vNormalView;
  varying vec3 vViewRay;
  varying vec2 vScreenUv;
  varying float vCurl;

  void main() {
    vec4 state = texture2D(uState, vUv);
    float layerMask = uLayer < 0.5
      ? state.r
      : (uLayer < 1.5 ? state.g : (uLayer < 2.5 ? state.b : state.a));
    float layerCoverage = smoothstep(0.02, 0.98, layerMask);
    if (layerCoverage < 0.01) discard;
    vec4 frontInk = texture2D(uArt, vUv);
    if (frontInk.a < 0.04) discard;

    vec3 normal = normalize(gl_FrontFacing ? vNormalWorld : -vNormalWorld);
    vec3 lightDirection = normalize(vec3(-0.38, 0.55, 0.74));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float grazing = pow(1.0 - abs(normal.z), 2.0);
    float specular = pow(max(dot(reflect(-lightDirection, normal), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
    vec3 color;
    float alpha;

    if (gl_FrontFacing) {
      color = frontInk.rgb * (0.61 + diffuse * 0.43);
      color += vec3(0.48, 0.40, 0.56) * grazing * 0.15 + specular * 0.22;
      color = mix(color, vec3(1.0, 0.52, 0.66), uStress * vCurl * 0.12);
      alpha = frontInk.a;

      // Released material settles close to the surface, but no longer reads as attached.
      if (uLayer > 0.5 && uLayer < 1.5) {
        color = mix(color, vec3(0.075, 0.045, 0.12), 0.46);
        alpha *= 0.52;
      }
    } else {
      // Baseline Snell refraction. The pre-lens scene is magnified as one image,
      // then its optical axis swings with the curved underside normal.
      vec3 incident = normalize(vViewRay);
      vec3 lensNormal = normalize(-vNormalView);
      float etaGreen = 1.0 / uIor;
      float etaRed = 1.0 / max(1.001, uIor - uDispersion);
      float etaBlue = 1.0 / (uIor + uDispersion);
      vec3 rayRed = refract(incident, lensNormal, etaRed);
      vec3 rayGreen = refract(incident, lensNormal, etaGreen);
      vec3 rayBlue = refract(incident, lensNormal, etaBlue);
      vec2 incidentSlope = incident.xy / max(abs(incident.z), 0.12);
      vec2 projectionScale = vec2(1.0 / max(uScreenAspect, 0.2), 1.0) * 0.072;
      vec2 shiftRed = (rayRed.xy / max(abs(rayRed.z), 0.12) - incidentSlope) * projectionScale;
      vec2 shiftGreen = (rayGreen.xy / max(abs(rayGreen.z), 0.12) - incidentSlope) * projectionScale;
      vec2 shiftBlue = (rayBlue.xy / max(abs(rayBlue.z), 0.12) - incidentSlope) * projectionScale;
      vec2 magnifiedUv = vec2(0.5) + (vScreenUv - vec2(0.5)) / uMagnification;
      vec2 uvRed = clamp(magnifiedUv + shiftRed, vec2(0.002), vec2(0.998));
      vec2 uvGreen = clamp(magnifiedUv + shiftGreen, vec2(0.002), vec2(0.998));
      vec2 uvBlue = clamp(magnifiedUv + shiftBlue, vec2(0.002), vec2(0.998));
      vec3 refractedScene = vec3(
        texture2D(uScene, uvRed).r,
        texture2D(uScene, uvGreen).g,
        texture2D(uScene, uvBlue).b
      );
      float fresnel = pow(1.0 - abs(dot(-incident, lensNormal)), 3.0);
      float sceneLuma = dot(refractedScene, vec3(0.2126, 0.7152, 0.0722));
      // Pre-composite the see-through view in monochrome so a colorful sticker
      // beneath the film can never read as artwork printed on its backside.
      color = mix(vec3(sceneLuma), uLensTint, 0.5 + fresnel * 0.08);
      color += vec3(0.62, 0.76, 1.0) * specular * 0.22;
      alpha = frontInk.a;
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
  private readonly stateTexture: THREE.DataTexture;
  private readonly refractionTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
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
  // The transparent underside must refract the level beneath it, never a render
  // of the same in-hand piece. Both faces of lifted and torn layers are excluded.
  private readonly refractionExcludedMeshes: THREE.Mesh[] = [];
  private lensActive = false;
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
    lensProfile: LensProfile = "bubble",
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
    // The channels identify layers, while interpolation supplies sub-cell coverage
    // so diagonal release fronts do not expose the simulation grid as stair steps.
    this.stateTexture.minFilter = THREE.LinearFilter;
    this.stateTexture.magFilter = THREE.LinearFilter;
    this.stateTexture.needsUpdate = true;

    const art = makeArtTexture(artwork);
    const geometry = new THREE.PlaneGeometry(this.stickerWidth, this.stickerHeight, 124, 100);
    const lens = lensProfile === "prismatic"
      ? { ior: 1.52, magnification: 1.16, dispersion: 0.018, tint: 0x9a78d6 }
      : lensProfile === "bubble"
        ? { ior: 1.46, magnification: 1.12, dispersion: 0.008, tint: 0x7937bd }
        : { ior: 1.33, magnification: 1.04, dispersion: 0.002, tint: 0xbfc9dc };
    const layerPasses = [
      { layer: 0, side: THREE.FrontSide, depthWrite: true, renderOrder: 0 },
      { layer: 1, side: THREE.FrontSide, depthWrite: false, renderOrder: 1 },
      { layer: 2, side: THREE.BackSide, depthWrite: false, renderOrder: 2 },
      { layer: 2, side: THREE.FrontSide, depthWrite: true, renderOrder: 3 },
      { layer: 3, side: THREE.BackSide, depthWrite: false, renderOrder: 4 },
      { layer: 3, side: THREE.FrontSide, depthWrite: true, renderOrder: 5 },
    ] as const;
    for (const pass of layerPasses) {
      const uniforms: PeelUniforms = {
        uArt: { value: art },
        uScene: { value: this.refractionTarget.texture },
        uState: { value: this.stateTexture },
        uLayer: { value: pass.layer },
        uIor: { value: lens.ior },
        uMagnification: { value: lens.magnification },
        uDispersion: { value: lens.dispersion },
        uLensTint: { value: new THREE.Color(lens.tint) },
        uScreenAspect: { value: 1 },
        uGrab: { value: new THREE.Vector2(-2.1, 0) },
        uPointer: { value: new THREE.Vector2(-2.1, 0) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uFrontDepth: { value: 0 },
        uRadius: { value: 0.31 },
        uCone: { value: 0 },
        uStress: { value: 0 },
        uTornOffset: { value: new THREE.Vector2() },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
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
      if (pass.layer >= 2) this.refractionExcludedMeshes.push(mesh);
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

  setPeel(
    grab: Vec2,
    pointer: Vec2,
    direction: Vec2,
    depth: number,
    profile: CurlProfile,
    stress: number,
    tornOffset: Vec2 = { x: 0, y: 0 },
    torn = false,
  ) {
    this.lensActive = depth > 0.002 || torn;
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
      uniforms.uTornOffset.value.set(tornOffset.x * this.stickerWidth, tornOffset.y * this.stickerHeight);
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
    this.refractionTarget.dispose();
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
    const lensResolutionScale = 0.75;
    this.refractionTarget.setSize(
      Math.max(1, Math.floor(width * this.pixelRatio * lensResolutionScale)),
      Math.max(1, Math.floor(height * this.pixelRatio * lensResolutionScale)),
    );
    this.camera.aspect = width / height;
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const margin = width < 680 ? 1.14 : 1.09;
    const verticalDistance = this.stickerHeight * 0.5 * margin / tangent;
    const horizontalDistance = this.stickerWidth * 0.5 * margin / (tangent * this.camera.aspect);
    this.camera.position.set(0, 0, Math.max(verticalDistance, horizontalDistance));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    for (const material of this.materials) {
      (material.uniforms as unknown as PeelUniforms).uScreenAspect.value = this.camera.aspect;
    }
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.lensActive && this.refractionExcludedMeshes.length > 0) {
      for (const mesh of this.refractionExcludedMeshes) mesh.visible = false;
      this.renderer.setRenderTarget(this.refractionTarget);
      this.renderer.render(this.scene, this.camera);
      for (const mesh of this.refractionExcludedMeshes) mesh.visible = true;
      this.renderer.setRenderTarget(null);
    }
    this.renderer.render(this.scene, this.camera);
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.lastFpsTime > 650) {
      const fps = Math.round(this.fpsFrames * 1000 / (now - this.lastFpsTime));
      this.onFps?.(fps);
      this.fpsFrames = 0;
      this.lastFpsTime = now;
    }
  };
}
