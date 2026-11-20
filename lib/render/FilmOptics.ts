import * as THREE from "three";

/** Capture the visible scene before drawing the refracting film, without feedback. */
export class FilmOptics {
  texture = new THREE.FramebufferTexture(1, 1);
  readonly size = new THREE.Vector2(1, 1);

  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, film: THREE.Object3D[]) {
    renderer.getDrawingBufferSize(this.size);
    if (this.texture.image.width !== this.size.x || this.texture.image.height !== this.size.y) {
      this.texture.dispose();
      this.texture = new THREE.FramebufferTexture(this.size.x, this.size.y);
      this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    }
    const visibility = film.map(mesh => mesh.visible);
    try {
      for (const mesh of film) mesh.visible = false;
      renderer.render(scene, camera);
      // Copy the actual output pixels so all surfaces retain their display color.
      renderer.copyFramebufferToTexture(this.texture);
    } finally {
      film.forEach((mesh, index) => { mesh.visible = visibility[index]; });
    }
  }

  dispose() { this.texture.dispose(); }
}
