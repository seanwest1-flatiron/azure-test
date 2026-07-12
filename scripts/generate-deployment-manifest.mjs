import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outputPath = resolve(process.argv[2] || "deployment.json");
const commit = process.env.GITHUB_SHA;

if (!commit) {
  throw new Error("GITHUB_SHA is required to generate the GitHub Pages deployment manifest.");
}

const manifest = {
  commit,
  deployedAt: new Date().toISOString()
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
