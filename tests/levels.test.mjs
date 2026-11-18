import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("every listed level retains its move limit and has build-ready matching artwork", () => {
  const read = path => JSON.parse(readFileSync(path, "utf8"));
  const catalog = read("lib/peel/levels.json");
  const packs = read("sticker/_packlist.json");
  let count = 0;
  for (const pack of packs) {
    for (const entry of read(`sticker/${pack}/_packinfo.json`).levels) {
      const level = catalog.find(level => level.id === `${pack}/${entry.img}`);
      assert.ok(level, `Missing level ${pack}/${entry.img}`);
      assert.equal(level.maxMoves, entry.moves);
      assert.equal(level.density, entry.den);
      const source = readFileSync(`sticker/${pack}/${entry.img}`);
      assert.deepEqual(readFileSync(resolve("public", level.artwork.slice(1))), source);
      assert.equal(source.subarray(1, 4).toString(), "PNG");
      count++;
    }
  }
  assert.equal(catalog.length, count);
  assert.equal(new Set(catalog.map(level => level.id)).size, count);
});
