import * as THREE from "three";
import { SPACE, SURFACE_TEXTURE } from "./PeelAppearance";
import { surfaceTextureShader } from "./SurfaceTexture";

type StickerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

// The shadow pass reuses the peel shaders so curls, tears, and dissolves stay in sync.
const fragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uEye;
  uniform vec2 uViewScale;
  uniform vec2 uParallax;
  uniform float uDepth;
  uniform float uSpace;
  uniform sampler2D uShadow;
  uniform sampler2D uSoftShadow;
  uniform float uShadowStrength;
  uniform vec2 uShadowExtent;
  uniform vec2 uShadowSlope;
  uniform vec3 uBackdrop;
  varying vec3 vWorld;

  ${surfaceTextureShader}

  void main() {
    vec2 p = vWorld.xy;
    vec2 paneUv = p / uViewScale;
    vec3 hit = vWorld;
    vec3 color;

    if (uSpace == ${SPACE.glass}.0) {
      // Move the virtual eye behind the pane without moving the playable sticker.
      vec3 ray = normalize(vWorld - uEye);
      ray.xy += uParallax / max(1.0, uEye.z);
      ray.xy += vec2(sin(p.y * 2.1), sin(p.x * 1.7)) * 0.0016;
      hit += ray * ((-uDepth - vWorld.z) / ray.z);
      vec2 lightUv = (hit.xy / uViewScale - vec2(-0.55, 0.55)) * vec2(1.15, 0.95);
      float lightPool = exp(-dot(lightUv, lightUv) * 1.5);
      color = uBackdrop * (0.53 + lightPool * 1.37) + vec3(0.012 + lightPool * 0.018);
    } else if (uSpace == ${SPACE.darkroom}.0) {
      vec2 lightUv = (paneUv - vec2(-0.42, 0.30)) * vec2(0.8, 1.2);
      float halo = exp(-dot(lightUv, lightUv) * 2.1);
      color = vec3(0.003, 0.0035, 0.005) + halo * vec3(0.017, 0.019, 0.025);
    } else if (uSpace == ${SPACE.paper}.0) {
      vec2 lightUv = (paneUv - vec2(-0.53, 0.42)) * vec2(0.80, 0.65);
      float wash = exp(-dot(lightUv, lightUv) * 0.72);
      color = shadeSurfaceTexture(vec3(0.54, 0.41, 0.29) * (0.76 + 0.43 * wash), p, ${SURFACE_TEXTURE.paper}.0);
    } else {
      vec2 lightUv = (paneUv - vec2(0.04, 0.17)) * vec2(0.82, 0.94);
      float glow = exp(-dot(lightUv, lightUv) * 0.85);
      color = mix(vec3(0.16, 0.27, 0.34), vec3(0.83, 0.98, 1.05), glow);
      color += surfaceDetail(p, vec2(34.0)) * 0.035;
    }

    if (uShadowStrength > 0.0) {
      vec2 shadowUv = (hit.xy + hit.z * uShadowSlope) / (2.0 * uShadowExtent) + 0.5;
      float inside = step(0.0, shadowUv.x) * step(shadowUv.x, 1.0)
                   * step(0.0, shadowUv.y) * step(shadowUv.y, 1.0);
      vec2 uv = clamp(shadowUv, 0.0, 1.0);
      vec2 soft = texture2D(uSoftShadow, uv).rg;
      float coverage = soft.r;
      if (uSpace == ${SPACE.paper}.0) {
        // The green channel carries the caster height weighted by its coverage.
        float height = soft.g / max(0.001, coverage);
        float contact = texture2D(uShadow, uv).r;
        coverage = mix(contact, soft.r, mix(0.18, 1.0, smoothstep(0.02, 0.50, height)));
      }
      color *= 1.0 - coverage * inside * uShadowStrength;
    }

    if (uSpace == ${SPACE.glass}.0) {
      float broad = exp(-pow((paneUv.x * 0.42 + paneUv.y - 0.80 + uParallax.y) / 0.17, 2.0));
      float grazing = pow(clamp(length(paneUv) * 0.68, 0.0, 1.0), 4.0);
      color += mix(vec3(0.37, 0.42, 0.49), uBackdrop, 0.3) * (broad * 0.065 + grazing * 0.035);
    }
    color += (surfaceHash(gl_FragCoord.xy) - 0.5) * 0.003;
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SHADOW_RESOLUTION = 512;

export class PeelEnvironment {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly shadowScene = new THREE.Scene();
  private readonly shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  private readonly shadowTarget = new THREE.WebGLRenderTarget(SHADOW_RESOLUTION, SHADOW_RESOLUTION, { depthBuffer: false });
  private readonly blurTarget = this.shadowTarget.clone();
  private readonly softShadow = this.shadowTarget.clone();
  private readonly shadowSlope = new THREE.Vector2();
  private readonly blurScene = new THREE.Scene();
  private readonly blurCamera = new THREE.Camera();
  private readonly blur = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uInput: { value: this.shadowTarget.texture }, uStep: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uInput;
      uniform vec2 uStep;
      varying vec2 vUv;
      void main() {
        vec2 shadow = texture2D(uInput, vUv).rg * 0.227027;
        shadow += texture2D(uInput, vUv + uStep * 1.384615).rg * 0.316216;
        shadow += texture2D(uInput, vUv - uStep * 1.384615).rg * 0.316216;
        shadow += texture2D(uInput, vUv + uStep * 3.230769).rg * 0.070270;
        shadow += texture2D(uInput, vUv - uStep * 3.230769).rg * 0.070270;
        gl_FragColor = vec4(shadow, 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }));
  private readonly shadowMeshes = new Map<StickerMesh, StickerMesh>();
  private readonly clearColor = new THREE.Color();
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly parallax = new THREE.Vector2();
  private lastTime = 0;

  constructor() {
    this.shadowCamera.position.z = 10;
    this.blur.frustumCulled = false;
    this.blurScene.add(this.blur);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: {
        uEye: { value: new THREE.Vector3() },
        uViewScale: { value: new THREE.Vector2(3, 3) },
        uParallax: { value: this.parallax },
        uDepth: { value: 3 },
        uSpace: { value: SPACE.glass },
        uShadow: { value: this.shadowTarget.texture },
        uSoftShadow: { value: this.softShadow.texture },
        uShadowStrength: { value: 0 },
        uShadowExtent: { value: new THREE.Vector2(6, 6) },
        uShadowSlope: { value: this.shadowSlope },
        uBackdrop: { value: new THREE.Color("#25222b") },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader,
    }));
    this.mesh.position.z = -0.095;
    this.mesh.visible = false;
  }

  setSpace(space: number, color: string) {
    this.mesh.visible = space !== SPACE.original;
    const { uSpace, uBackdrop } = this.mesh.material.uniforms;
    uSpace.value = space;
    uBackdrop.value.set(color);
    if (space === SPACE.paper) this.shadowSlope.set(0.53, -0.39);
    else if (space === SPACE.darkroom) this.shadowSlope.set(0.75, -0.60);
    else if (space === SPACE.lightbox) this.shadowSlope.set(0.17, -0.15);
    else this.shadowSlope.set(0.42, -0.25);

    if (!this.mesh.visible) this.pruneShadowMeshes([]);
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sources: StickerMesh[], now: number,
    dragging: boolean, shadow: boolean) {
    const uniforms = this.mesh.material.uniforms;
    const space = uniforms.uSpace.value;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (this.reducedMotion.matches) {
      this.parallax.set(0, 0);
    } else if (space === SPACE.glass && !dragging) {
      const smoothing = 1 - Math.exp(-dt * 2);
      this.parallax.lerp(new THREE.Vector2(Math.sin(now * 0.00022) * 0.09, Math.cos(now * 0.00017) * 0.055), smoothing);
    }
    const halfHeight = (camera.position.z - this.mesh.position.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfWidth = halfHeight * camera.aspect;
    // Cover the viewport without drawing a front-pane edge.
    this.mesh.position.setX(camera.position.x).setY(camera.position.y);
    this.mesh.scale.set(halfWidth * 1.01, halfHeight * 1.01, 1);
    uniforms.uEye.value.copy(camera.position);
    uniforms.uViewScale.value.set(halfWidth * 1.12, halfHeight * 1.12);
    uniforms.uDepth.value = Math.max(3.2, Math.min(halfWidth, halfHeight) * 1.5);
    const strength = space === SPACE.glass ? 0.72 : space === SPACE.paper ? 0.49 : 0.30;
    uniforms.uShadowStrength.value = shadow ? strength : 0;
    this.pruneShadowMeshes(shadow ? sources : []);
    if (!shadow) return;

    const extent = uniforms.uShadowExtent.value as THREE.Vector2;
    extent.set(
      Math.max(6, Math.abs(camera.position.x) + halfWidth * 1.4),
      Math.max(6, Math.abs(camera.position.y) + halfHeight * 1.4),
    );
    this.shadowCamera.left = -extent.x;
    this.shadowCamera.right = extent.x;
    this.shadowCamera.top = extent.y;
    this.shadowCamera.bottom = -extent.y;
    this.shadowCamera.updateProjectionMatrix();

    for (const source of sources) {
      let mesh = this.shadowMeshes.get(source);
      if (!mesh) {
        const material = new THREE.ShaderMaterial({
          uniforms: { ...source.material.uniforms, uShadowSlope: uniforms.uShadowSlope },
          defines: { ...source.material.defines },
          vertexShader: `uniform vec2 uShadowSlope;\n${source.material.vertexShader}`.replace(
            "gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
            `vec4 world = modelMatrix * vec4(p, 1.0);
             world.xy += world.z * uShadowSlope;
             gl_Position = projectionMatrix * viewMatrix * vec4(world.xy, 0.0, 1.0);`,
          ),
          fragmentShader: source.material.fragmentShader.replace(
            "gl_FragColor = vec4(color, alpha * layerCoverage);",
            "gl_FragColor = vec4(1.0, clamp(vLift, 0.0, 1.0), 0.0, alpha * layerCoverage);",
          ),
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        });
        mesh = new THREE.Mesh(source.geometry, material);
        mesh.frustumCulled = false;
        this.shadowMeshes.set(source, mesh);
        this.shadowScene.add(mesh);
      }
      mesh.position.copy(source.position);
      mesh.visible = source.visible;
    }

    const target = renderer.getRenderTarget();
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.shadowScene, this.shadowCamera);
    const blurStep = (space === SPACE.paper ? 1.65 : 2.5) / SHADOW_RESOLUTION;
    this.blur.material.uniforms.uInput.value = this.shadowTarget.texture;
    this.blur.material.uniforms.uStep.value.set(blurStep, 0);
    renderer.setRenderTarget(this.blurTarget);
    renderer.render(this.blurScene, this.blurCamera);
    this.blur.material.uniforms.uInput.value = this.blurTarget.texture;
    this.blur.material.uniforms.uStep.value.set(0, blurStep);
    renderer.setRenderTarget(this.softShadow);
    renderer.render(this.blurScene, this.blurCamera);
    renderer.setRenderTarget(target);
    renderer.setClearColor(this.clearColor, alpha);
  }

  private pruneShadowMeshes(sources: StickerMesh[]) {
    if (!this.shadowMeshes.size) return;
    const active = new Set(sources);
    for (const [source, mesh] of this.shadowMeshes) {
      if (active.has(source)) continue;
      this.shadowScene.remove(mesh);
      mesh.material.dispose();
      this.shadowMeshes.delete(source);
    }
  }

  dispose() {
    this.pruneShadowMeshes([]);
    this.shadowTarget.dispose();
    this.blurTarget.dispose();
    this.softShadow.dispose();
    this.blur.geometry.dispose();
    this.blur.material.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
