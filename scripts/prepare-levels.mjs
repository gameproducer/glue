import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "sticker");
const packs = JSON.parse(readFileSync(join(source, "_packlist.json"), "utf8"));
const catalog = [];
for (const pack of packs) {
  if (!/^[\w-]+$/.test(pack)) throw new Error(`Invalid pack: ${pack}`);
  const metadata = JSON.parse(readFileSync(join(source, pack, "_packinfo.json"), "utf8"));
  for (const entry of metadata.levels) {
    if (!/^[\w.-]+\.png$/i.test(entry.img) || !Number.isInteger(entry.moves) || entry.moves < 1) {
      throw new Error(`Invalid level in ${pack}: ${entry.img}`);
    }
    const output = join(root, "public", "stickers", pack);
    mkdirSync(output, { recursive: true });
    copyFileSync(join(source, pack, entry.img), join(output, entry.img));
    catalog.push({
      id: `${pack}/${entry.img}`,
      pack: metadata.name || pack.replaceAll("_", " "),
      name: entry.img.replace(/-512\.png$/i, "").replaceAll("_", " "),
      artwork: `/stickers/${pack}/${entry.img}`,
      maxMoves: entry.moves,
      density: entry.den,
    });
  }
}
if (new Set(catalog.map(level => level.id)).size !== catalog.length) throw new Error("Duplicate level IDs");
writeFileSync(join(root, "lib", "peel", "levels.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(`Prepared ${catalog.length} sticker levels in ${packs.length} packs.`);
