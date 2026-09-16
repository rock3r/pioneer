import path from "node:path";
import { pathToFileURL } from "node:url";
import { installAuthBrokerClient } from "./pi-auth-client.js";
import { restrictExtensionTools } from "./pi-extension-policy.js";

// The controller selects and validates the installed Pi root. This adapter runs only
// in the actor sandbox. Import the real CLI once to retain its dispatcher/startup semantics.
const root = process.argv[2];
const hasInspection = process.argv[3] === "--pioneer-inspection-extension";
const trustedInspectionPath = hasInspection ? process.argv[4] : undefined;
if (root === undefined) throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Missing Pi runtime");
await installAuthBrokerClient(root);
const loader = (await import(
  pathToFileURL(path.join(root, "dist/core/resource-loader.js")).href
)) as {
  DefaultResourceLoader: {
    prototype: { getExtensions: () => Parameters<typeof restrictExtensionTools>[0] };
  };
};
const prototype = loader.DefaultResourceLoader.prototype;
const original = prototype.getExtensions;
if (typeof original !== "function")
  throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Unsupported Pi resource-loader contract");
prototype.getExtensions = function () {
  return restrictExtensionTools(original.call(this), trustedInspectionPath);
};
process.argv = [
  process.argv[0] ?? process.execPath,
  path.join(root, "dist/cli.js"),
  ...process.argv.slice(hasInspection ? 5 : 3),
];
await import(pathToFileURL(path.join(root, "dist/cli.js")).href);
