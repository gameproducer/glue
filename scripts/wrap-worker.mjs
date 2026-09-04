import { rename, rm, writeFile } from "node:fs/promises";

const entry = new URL("../dist/server/index.js", import.meta.url);
const handler = new URL("../dist/server/vinext-handler.js", import.meta.url);

await rm(handler, { force: true });
await rename(entry, handler);
await writeFile(entry, `import handleRequest from "./vinext-handler.js";
export * from "./vinext-handler.js";

export default {
  fetch(request, env, context) {
    return handleRequest(request, env, context);
  },
};
`);
