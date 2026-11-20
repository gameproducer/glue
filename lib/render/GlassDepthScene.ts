import * as THREE from "three";

type StickerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

// A glass pane above an unbounded backdrop gives us reflections and depth
// without a visible enclosure. The sticker shadow uses a separate pass;
// it reuses the actual peel shaders so curls, tears, and dissolves stay in sync.
const fragmentShader = /* glsl */ `
  precision highp float;
  uniform vec3 uEye;
  uniform vec2 uViewScale;
  uniform vec2 uParallax;
  uniform float uDepth;
  uniform sampler2D uShadow;
  uniform vec2 uShadowExtent;
  varying vec3 vWorld;

  float noise(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 p = vWorld.xy;
    vec2 paneUv = p / uViewScale;

    // The ray starts on the glass. Move only the virtual eye behind it:
    // parallax never changes sticker framing or pointer-to-sticker mapping.
    vec3 ray = normalize(vWorld - uEye);
    ray.xy += uParallax / max(1.0, uEye.z);
    ray.xy += vec2(sin(p.y * 2.1), sin(p.x * 1.7)) * 0.0016;
    // Intersect only the distant plane. There are no side walls, floor,
    // ceiling, seams, or corners to reveal a box at any viewport or zoom.
    float rearT = (-uDepth - vWorld.z) / ray.z;
    vec3 hit = vWorld + ray * rearT;

    vec2 rearUv = hit.xy / uViewScale;
    float lightPool = exp(-dot((rearUv - vec2(-0.55, 0.55)) * vec2(1.15, 0.95),
                              (rearUv - vec2(-0.55, 0.55)) * vec2(1.15, 0.95)) * 1.5);
    vec3 color = mix(vec3(0.004, 0.025, 0.020), vec3(0.015, 0.31, 0.15), lightPool);
    // Parallel projection from the upper left light onto the distant plane.
    vec2 shadowUv = (hit.xy + hit.z * vec2(0.42, -0.25)) / (2.0 * uShadowExtent) + 0.5;
    float inside = step(0.0, shadowUv.x) * step(shadowUv.x, 1.0)
                 * step(0.0, shadowUv.y) * step(shadowUv.y, 1.0);
    color *= 1.0 - texture2D(uShadow, clamp(shadowUv, 0.0, 1.0)).r * inside * 0.72;

    // Front-surface reflections remain sharp above the soft interior.
    float strip = exp(-pow((paneUv.x + paneUv.y * 0.17 + 0.86 + uParallax.x * 0.6) / 0.045, 2.0));
    float broad = exp(-pow((paneUv.x * 0.42 + paneUv.y - 0.80 + uParallax.y) / 0.17, 2.0));
    float grazing = pow(clamp(length(paneUv) * 0.68, 0.0, 1.0), 4.0);
    color += vec3(0.30, 0.48, 0.42) * (strip * 0.23 + broad * 0.065 + grazing * 0.035);
    color += (noise(gl_FragCoord.xy) - 0.5) * 0.003;
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class GlassDepthScene {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly shadowScene = new THREE.Scene();
  private readonly shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  private readonly shadowTarget = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false });
  private readonly blurTarget = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false });
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
        float shadow = texture2D(uInput, vUv).r * 0.227027;
        shadow += texture2D(uInput, vUv + uStep * 1.384615).r * 0.316216;
        shadow += texture2D(uInput, vUv - uStep * 1.384615).r * 0.316216;
        shadow += texture2D(uInput, vUv + uStep * 3.230769).r * 0.070270;
        shadow += texture2D(uInput, vUv - uStep * 3.230769).r * 0.070270;
        gl_FragColor = vec4(vec3(shadow), 1.0);
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
        uShadow: { value: this.shadowTarget.texture },
        uShadowExtent: { value: new THREE.Vector2(6, 6) },
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

  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sources: StickerMesh[], now: number, dragging: boolean) {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (this.reducedMotion.matches) {
      this.parallax.set(0, 0);
    } else if (!dragging) {
      const smoothing = 1 - Math.exp(-dt * 2);
      this.parallax.lerp(new THREE.Vector2(Math.sin(now * 0.00022) * 0.09, Math.cos(now * 0.00017) * 0.055), smoothing);
    }
    const halfHeight = (camera.position.z - this.mesh.position.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfWidth = halfHeight * camera.aspect;
    // Cover the viewport without drawing a front-pane edge.
    this.mesh.position.setX(camera.position.x).setY(camera.position.y);
    this.mesh.scale.set(halfWidth * 1.01, halfHeight * 1.01, 1);
    const uniforms = this.mesh.material.uniforms;
    uniforms.uEye.value.copy(camera.position);
    uniforms.uViewScale.value.set(halfWidth * 1.12, halfHeight * 1.12);
    uniforms.uDepth.value = Math.max(3.2, Math.min(halfWidth, halfHeight) * 1.5);
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

    const active = new Set(sources);
    for (const [source, mesh] of this.shadowMeshes) {
      if (active.has(source)) continue;
      this.shadowScene.remove(mesh);
      mesh.material.dispose();
      this.shadowMeshes.delete(source);
    }
    for (const source of sources) {
      let mesh = this.shadowMeshes.get(source);
      if (!mesh) {
        const material = new THREE.ShaderMaterial({
          uniforms: source.material.uniforms,
          defines: { ...source.material.defines },
          vertexShader: source.material.vertexShader.replace(
            "gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
            `vec4 world = modelMatrix * vec4(p, 1.0);
             world.xy += world.z * vec2(0.42, -0.25);
             gl_Position = projectionMatrix * viewMatrix * vec4(world.xy, 0.0, 1.0);`,
          ),
          fragmentShader: source.material.fragmentShader.replace(
            "gl_FragColor = vec4(color, alpha * layerCoverage);",
            "gl_FragColor = vec4(vec3(1.0), alpha * layerCoverage);",
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
    // Separable Gaussian blur at 512px keeps the rear shadow soft without a
    // full-resolution depth-of-field pass over the playable sticker.
    this.blur.material.uniforms.uInput.value = this.shadowTarget.texture;
    this.blur.material.uniforms.uStep.value.set(2.5 / 512, 0);
    renderer.setRenderTarget(this.blurTarget);
    renderer.render(this.blurScene, this.blurCamera);
    this.blur.material.uniforms.uInput.value = this.blurTarget.texture;
    this.blur.material.uniforms.uStep.value.set(0, 2.5 / 512);
    renderer.setRenderTarget(this.shadowTarget);
    renderer.render(this.blurScene, this.blurCamera);
    renderer.setRenderTarget(target);
    renderer.setClearColor(this.clearColor, alpha);
  }

  dispose() {
    for (const mesh of this.shadowMeshes.values()) mesh.material.dispose();
    this.shadowMeshes.clear();
    this.shadowTarget.dispose();
    this.blurTarget.dispose();
    this.blur.geometry.dispose();
    this.blur.material.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
