// Mirrors the shared quality core into the frontend; the backend copy is canonical.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../backend/src/quality/core/quality-core.ts", import.meta.url));
const target = fileURLToPath(new URL("../frontend/src/lib/quality-core.ts", import.meta.url));
copyFileSync(source, target);
console.log("quality-core synced to frontend/src/lib/quality-core.ts");
