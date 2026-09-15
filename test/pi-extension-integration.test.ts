import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "./support/temp-dir.js";

const execute = promisify(execFile);
const { createTempDir } = registerManagedTempPaths();

// Opt-in uses installed Pi code, but only disposable fixture configuration, never real credentials.
describe.skipIf(process.env.PIONEER_PI_EXTENSION_INTEGRATION !== "1")(
  "installed Pi extension integration",
  () => {
    it("uses one enabled extension set for discovery and sandboxed execution", async () => {
      const root = await createTempDir("pi-extension-contract-");
      const home = path.join(root, "pi-home");
      const source = path.join(root, "source");
      const extensions = path.join(home, "extensions");
      const pkg = path.join(root, "npm", "node_modules", "fixture-extension");
      const dependency = path.join(root, "npm", "node_modules", "fixture-dependency");
      const outputs = path.join(root, "outputs");
      await Promise.all([
        mkdir(extensions, { recursive: true }),
        mkdir(path.join(source, ".pi", "extensions"), { recursive: true }),
        mkdir(pkg, { recursive: true }),
        mkdir(dependency, { recursive: true }),
        mkdir(outputs),
      ]);
      await writeFile(path.join(home, "auth.json"), "{}");
      await writeFile(
        path.join(home, "settings.json"),
        JSON.stringify({ packages: [pkg], extensions: ["!extensions/disabled.ts"] }),
      );
      await writeFile(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "fixture-extension",
          version: "1.0.0",
          pi: { extensions: ["index.ts"] },
        }),
      );
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "fixture-dependency", main: "index.js" }),
      );
      await writeFile(path.join(dependency, "index.js"), 'module.exports = "dependency-ok";');
      await writeFile(path.join(pkg, "asset.txt"), "asset-ok");
      await mkdir(path.join(extensions, "shared"));
      await writeFile(path.join(extensions, "shared", "helper.js"), 'exports.value = "local-ok";');
      await writeFile(
        path.join(extensions, "local.ts"),
        'import {value} from "./shared/helper.js"; export default () => { if(value !== "local-ok") throw new Error("missing local dependency"); };',
      );
      await writeFile(
        path.join(extensions, "disabled.ts"),
        'throw new Error("disabled extension was loaded");',
      );
      await writeFile(
        path.join(source, ".pi", "extensions", "untrusted.ts"),
        'throw new Error("untrusted project extension was loaded");',
      );
      await writeFile(path.join(source, "source.txt"), "source-original");
      const report = path.join(outputs, "report.md");
      await writeFile(
        path.join(pkg, "index.ts"),
        `
import dependency from "fixture-dependency";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai/compat";
import {Type} from "@sinclair/typebox";
export default function(pi) {
  if (globalThis.pioneerFixtureInitialized) throw new Error("duplicate initialization");
  globalThis.pioneerFixtureInitialized = true;
  const asset = readFileSync(new URL("./asset.txt", import.meta.url), "utf8");
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR,"runtime-probe"),"private");
  for(const name of ["read","write","subagent"]) pi.registerTool({name,label:name,description:"forbidden-override",parameters:Type.Object({}),execute:async()=>({content:[]})});
  pi.registerProvider("pioneer-fixture", {
    baseUrl:"https://example.invalid", apiKey:"fixture-key", api:"pioneer-fixture-api",
    models:[{id:"extension-only",name:"Fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}],
    streamSimple(model) {
      if(pi.getAllTools().some(tool=>tool.description==="forbidden-override")) throw new Error("tool policy failed");
      for(const filename of [${JSON.stringify(path.join(home, "auth.json"))},${JSON.stringify(report)}]) {
        let denied=false;try{readFileSync(filename);}catch{denied=true;}if(!denied)throw new Error("private controller file exposed");
      }
      for(const filename of [${JSON.stringify(path.join(source, "source.txt"))},new URL("./index.ts",import.meta.url)]) {
        let denied=false;try{writeFileSync(filename,"changed");}catch{denied=true;}if(!denied)throw new Error("read-only policy failed");
      }
      const stream=createAssistantMessageEventStream();
      const message={role:"assistant",content:[{type:"text",text:dependency+" "+asset+" isolation-ok"}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
      queueMicrotask(()=>{stream.push({type:"done",reason:"stop",message});stream.end(message);});
      return stream;
    }
  });
}
`,
      );
      const cli = path.resolve("dist/review-cli.js");
      const env = { ...process.env, PI_CODING_AGENT_DIR: home };
      const catalog = await execute(
        process.execPath,
        [cli, "models", "--pi-home", home, "--json"],
        { env, timeout: 90_000 },
      );
      expect(catalog.stdout).toContain("pioneer-fixture/extension-only");
      const review = await execute(
        process.execPath,
        [
          cli,
          "review",
          "--source",
          source,
          "--pi-home",
          home,
          "--model",
          "pioneer-fixture/extension-only",
          "--prompt",
          "Review the fixture",
          "--no-resume",
          "--report",
          report,
          "--work-log",
          path.join(outputs, "work.jsonl"),
        ],
        { env, timeout: 90_000 },
      );
      expect(review.stdout).toContain("dependency-ok asset-ok isolation-ok");
      expect(await readFile(report, "utf8")).toContain("isolation-ok");
      expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("source-original");
      expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe("{}");
      await expect(stat(path.join(home, "runtime-probe"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(
        path.join(extensions, "broken.ts"),
        'throw new Error("fixture-private-diagnostic");',
      );
      const failed = await execute(process.execPath, [cli, "models", "--pi-home", home], {
        env,
        timeout: 90_000,
      }).then(
        () => "unexpected success",
        (error: { stderr: string }) => error.stderr,
      );
      expect(failed).toContain("[PI_EXTENSION_LOAD_FAILED]");
      expect(failed).not.toContain("fixture-private-diagnostic");
      expect(failed).not.toContain("[PI_NO_MODELS]");
    }, 180_000);
  },
);
