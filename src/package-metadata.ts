import { readFileSync } from "node:fs";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

if (manifest.name !== "@rock3r/pioneer" || typeof manifest.version !== "string") {
  throw new Error("Pioneer package metadata is invalid");
}

export const PIONEER_VERSION = manifest.version;
