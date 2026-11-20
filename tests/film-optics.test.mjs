import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FilmOptics } from "../lib/render/FilmOptics.ts";
import { DEFAULT_APPEARANCE, FILM_OPTICS, readAppearance } from "../lib/render/PeelAppearance.ts";

test("film refraction captures the scene without its own film and restores visibility", () => {
  const optics = new FilmOptics();
  const film = [new THREE.Object3D(), new THREE.Object3D()];
  film[1].visible = false;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const calls = [];
  const renderer = {
    getDrawingBufferSize: size => size.set(1600, 900),
    render(s, c) {
      assert.equal(s, scene);
      assert.equal(c, camera);
      assert.ok(film.every(mesh => !mesh.visible));
      calls.push("scene");
    },
    copyFramebufferToTexture(texture) {
      assert.equal(texture.image.width, optics.size.x);
      assert.equal(texture.image.height, optics.size.y);
      calls.push("copy");
    },
  };
  optics.capture(renderer, scene, camera, film);
  assert.deepEqual(optics.size.toArray(), [1600, 900]);
  assert.deepEqual(calls, ["scene", "copy"]);
  assert.deepEqual(film.map(mesh => mesh.visible), [true, false]);
  const texture = optics.texture;
  optics.capture(renderer, scene, camera, film);
  assert.equal(optics.texture, texture);
  renderer.getDrawingBufferSize = size => size.set(900, 1600);
  optics.capture(renderer, scene, camera, film);
  assert.notEqual(optics.texture, texture);
  assert.deepEqual(optics.size.toArray(), [900, 1600]);
  renderer.copyFramebufferToTexture = () => { throw new Error("capture failed"); };
  assert.throws(() => optics.capture(renderer, scene, camera, film), /capture failed/);
  assert.deepEqual(film.map(mesh => mesh.visible), [true, false]);
  optics.dispose();
});

test("film optics defaults off and saves independently from the back material", () => {
  assert.equal(FILM_OPTICS[DEFAULT_APPEARANCE.optics], "Off");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let saved = { back: 6, optics: 3 };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify(saved) } });
  try {
    assert.equal(readAppearance().back, 6);
    assert.equal(FILM_OPTICS[readAppearance().optics], "Psychedelic");
    saved = { back: 6 };
    assert.equal(readAppearance().optics, 0);
    saved.optics = 99;
    assert.equal(readAppearance().optics, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
