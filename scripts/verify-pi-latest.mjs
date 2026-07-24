import { readFile } from "node:fs/promises";

const policy = JSON.parse(await readFile("pi-compatibility.json", "utf8"));
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(policy.package)}/latest`,
  { headers: { accept: "application/json" } },
);
if (!response.ok) {
  throw new Error(`Pi registry lookup failed with HTTP ${response.status}`);
}
const latest = (await response.json()).version;
if (typeof latest !== "string") throw new Error("Pi registry returned no latest version");
if (latest !== policy.testedMaximum) {
  throw new Error(
    `Pi testedMaximum is ${policy.testedMaximum}, but npm latest is ${latest}. Review the upstream changes, update pi-compatibility.json, and run the endpoint compatibility matrix before releasing.`,
  );
}
process.stdout.write(`Pi tested maximum is current: ${latest}\n`);
