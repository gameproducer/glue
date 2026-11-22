import type { MeshBasicMaterial, MeshStandardMaterial } from "three";
import { SURFACE_TEXTURE } from "./PeelAppearance";

export const surfaceTextureShader = /* glsl */ `
  float surfaceHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  float surfaceNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(surfaceHash(cell), surfaceHash(cell + vec2(1.0, 0.0)), f.x),
               mix(surfaceHash(cell + vec2(0.0, 1.0)), surfaceHash(cell + 1.0), f.x), f.y) - 0.5;
  }

  float surfaceDetail(vec2 p, vec2 frequency) {
    vec2 samplePosition = p * frequency;
    vec2 footprint = fwidth(samplePosition);
    return surfaceNoise(samplePosition) * (1.0 - smoothstep(0.5, 1.4, max(footprint.x, footprint.y)));
  }

  vec3 shadeSurfaceTexture(vec3 color, vec2 p, float textureMode) {
    if (textureMode < 0.5) return color;
    float detail;
    if (textureMode == ${SURFACE_TEXTURE.paper}.0) {
      vec2 fiber = mat2(0.93, -0.37, 0.37, 0.93) * p;
      detail = surfaceDetail(p, vec2(12.0)) * 0.11 + surfaceDetail(p, vec2(38.0)) * 0.10
        + surfaceDetail(fiber, vec2(133.0, 25.0)) * 0.19
        + surfaceDetail(fiber.yx + 13.5, vec2(152.0, 37.0)) * 0.08;
    } else {
      detail = surfaceDetail(p, vec2(95.0)) * 0.25 + surfaceDetail(p, vec2(44.0)) * 0.13;
    }
    return max(vec3(0.0), color * (0.97 + detail) + detail * 0.045);
  }
`;

export function addSurfaceTexture(material: MeshBasicMaterial | MeshStandardMaterial, textureMode: { value: number }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSurfaceTexture = textureMode;
    shader.vertexShader = `varying vec2 vSurfacePosition;\n${shader.vertexShader}`.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\nvSurfacePosition = (modelMatrix * vec4(transformed, 1.0)).xy;",
    );
    shader.fragmentShader = `uniform float uSurfaceTexture;\nvarying vec2 vSurfacePosition;\n${surfaceTextureShader}\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      "outgoingLight = shadeSurfaceTexture(outgoingLight, vSurfacePosition, uSurfaceTexture);\n#include <opaque_fragment>",
    );
  };
}
