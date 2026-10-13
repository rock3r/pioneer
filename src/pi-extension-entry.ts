import path from "node:path";
import { pathToFileURL } from "node:url";
import { installAuthBrokerClient } from "./pi-auth-client.js";
import { restrictExtensionTools } from "./pi-extension-policy.js";
import { containSandboxSubprocessDenials } from "./pi-extension-subprocess-guard.js";

// The controller selects and validates the installed Pi root. This adapter runs only
// in the actor sandbox. Import the real CLI once to retain its dispatcher/startup semantics.
const root = process.argv[2];
// Each `--pioneer-inspection-extension PATH` pair names a controller-staged extension file or
// package directory whose tools survive: deep review's inspection tools or an eval's
// `--pi-extension`. Every other extension keeps only its provider and lifecycle hooks.
// `--pioneer-no-fork-sandbox` marks an actor that the controller launched without process
// creation (macOS reviews, discovery and deep review).
const trustedToolPaths: string[] = [];
let noForkSandbox = false;
let piArgumentsStart = 3;
for (;;) {
  const flag = process.argv[piArgumentsStart];
  if (flag === "--pioneer-no-fork-sandbox") {
    noForkSandbox = true;
    piArgumentsStart += 1;
  } else if (flag === "--pioneer-inspection-extension") {
    const trustedPath = process.argv[piArgumentsStart + 1];
    if (trustedPath === undefined)
      throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Missing trusted extension path");
    trustedToolPaths.push(trustedPath);
    piArgumentsStart += 2;
  } else {
    break;
  }
}
if (root === undefined) throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Missing Pi runtime");
// In a no-fork sandbox, an extension that starts a background child without handling the
// denial must not stop the whole Pi process.
if (noForkSandbox) containSandboxSubprocessDenials(process, (text) => process.stderr.write(text));
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
  return restrictExtensionTools(original.call(this), trustedToolPaths);
};
process.argv = [
  process.argv[0] ?? process.execPath,
  path.join(root, "dist/cli.js"),
  ...process.argv.slice(piArgumentsStart),
];
await import(pathToFileURL(path.join(root, "dist/cli.js")).href);
