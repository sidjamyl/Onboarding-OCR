// OCR owns these pure comparison rules; the backend mirror keeps its Docker build self-contained.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../backend/src/domain/ocr-consistency/", import.meta.url));
mkdirSync(destination, { recursive: true });
for (const filename of ["result.ts", "text.ts", "cross.ts", "consistency.ts"]) {
  const source = readFileSync(fileURLToPath(new URL(`../../OCR/src/core/validation/${filename}`, import.meta.url)), "utf8");
  writeFileSync(fileURLToPath(new URL(`../backend/src/domain/ocr-consistency/${filename}`, import.meta.url)),
    source.replace(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"'));
}
console.log("OCR consistency core synced to backend/src/domain/ocr-consistency");
