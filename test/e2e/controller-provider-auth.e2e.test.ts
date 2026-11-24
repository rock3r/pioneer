import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createEvalWorkspace, nativeEvalSandboxAvailable, runPioneer } from "./support/harness.js";
import { writeScriptedPi } from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();

it.skipIf(!sandboxReady).each(["review", "eval"] as const)(
  "%s keeps credentials in the controller and applies provider-only egress rules",
  async (mode) => {
    const workspace = await createEvalWorkspace(`controller-auth-${mode}`);
    const hostname = "pioneer-fixture.invalid";
    const modelSecret = "mock-provider-key-controller-only";
    const secondary = "mock-secondary-credential";
    const observedHeaders: Array<string | undefined> = [];
    const provider = http.createServer((request, response) => {
      observedHeaders.push(request.headers.authorization);
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "Protected provider reply", redacted: modelSecret }));
    });
    await new Promise<void>((bound) => provider.listen(0, "127.0.0.1", bound));
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("Mock provider not bound");
    try {
      const sourceAuth = JSON.stringify({
        scripted: { type: "api_key", key: "$PIONEER_TEST_MOCK_KEY" },
        unrelated: { type: "oauth", access: secondary, refresh: "mock-unused-refresh", expires: 0 },
      });
      await writeFile(path.join(workspace.piHome, "auth.json"), sourceAuth);
      await writeFile(
        path.join(workspace.piHome, "models.json"),
        JSON.stringify({
          providers: {
            scripted: {
              api: "openai-completions",
              baseUrl: `https://${hostname}/v1`,
              models: [{ id: "fake-model" }],
            },
          },
        }),
      );
      const pi = await writeScriptedPi(workspace, { actor: { kind: "reply-verbatim" } });
      await writeFile(
        pi,
        `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const directory = process.env.PI_CODING_AGENT_DIR;
const auth = JSON.parse(fs.readFileSync(path.join(directory, 'auth.json'), 'utf8'));
const provider = JSON.parse(fs.readFileSync(path.join(directory, 'models.json'), 'utf8')).providers.scripted;
const key = auth.scripted.key;
if (!/^[a-f0-9]{64}$/.test(key) || key !== provider.apiKey || Object.keys(auth).length !== 1 ||
    process.env.PIONEER_TEST_MOCK_KEY !== undefined || fs.existsSync(path.join(directory, 'settings.json'))) {
  throw new Error('Invalid protected actor configuration');
}
if (argv.includes('--version')) {
  console.log('0.84.2');
} else if (argv.includes('--list-models')) {
  console.log('provider  model  context  max-out  thinking  images\nscripted  fake-model  1K  1K  no  no');
} else {
  const reply = async () => {
    const response = await fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'fake-model', messages: [] }),
    });
    const result = await response.json();
    if (!response.ok || result.redacted !== '[REDACTED]') throw new Error('Protected provider request failed');
    return result.text;
  };
  const fail = () => { process.stderr.write('Mock actor provider call failed\n'); process.exitCode = 1; };
  if (argv.includes('rpc')) {
    process.stdin.once('data', () => {
      process.stdin.pause();
      reply().then((text) => {
        console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: text } }));
        console.log(JSON.stringify({ type: 'agent_settled' }));
      }).catch(fail);
    });
  } else reply().then(console.log).catch(fail);
}
`}`,
      );
      const intercept = path.join(workspace.root, "controller-network-fixture.mjs");
      const dnsCalls = path.join(workspace.root, "provider-dns-calls.txt");
      await writeFile(
        intercept,
        `import dns from 'node:dns/promises';
import { appendFileSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const lookup = dns.lookup;
const request = https.request;
dns.lookup = async (name, options) => {
  if (name !== ${JSON.stringify(hostname)}) return lookup(name, options);
  appendFileSync(${JSON.stringify(dnsCalls)}, name + '\\n');
  return [{ address: '93.184.216.34', family: 4 }];
};
https.request = (options, callback) => {
  if (options.servername !== ${JSON.stringify(hostname)}) return request(options, callback);
  if (options.host !== '93.184.216.34' || options.path !== '/v1/chat/completions' || options.rejectUnauthorized !== true) throw Error('Gateway omitted the fixed TLS destination');
  return http.request({ ...options, host: '127.0.0.1', port: ${address.port} }, callback);
};
syncBuiltinESMExports();\n`,
      );
      const isolatedWorkspace = {
        ...workspace,
        environment: {
          ...workspace.environment,
          NODE_OPTIONS: `--import=${pathToFileURL(intercept).href}`,
          PIONEER_TEST_MOCK_KEY: modelSecret,
        },
      };
      const dir = path.join(workspace.root, "actor-cwd");
      await mkdir(dir);
      const run = async (blocked: boolean) => {
        const attempt = blocked ? "blocked" : "allowed";
        const common = [
          "--controller-provider-auth",
          "--network",
          "provider-only",
          "--pi-home",
          workspace.piHome,
          "--work-log",
          workspace.workLogPath(attempt),
          ...(blocked ? ["--block-host", hostname] : []),
        ];
        const model = ["--model", "scripted/fake-model"];
        const args =
          mode === "review"
            ? [
                "review",
                "--source",
                dir,
                "--prompt",
                "Inspect this directory.",
                ...model,
                "--report",
                path.join(workspace.root, `${attempt}.md`),
                ...common,
              ]
            : [
                "eval",
                "run",
                "--run-dir",
                dir,
                ...common,
                "--",
                "pi",
                ...model,
                "--print",
                "Reply.",
              ];
        const result = await runPioneer(isolatedWorkspace, args);
        expect(result.stdout + result.stderr).not.toContain(modelSecret);
        expect(result.stdout + result.stderr).not.toContain(secondary);
        return result;
      };

      const denied = await run(true);
      expect(denied.exitCode, denied.stderr).toBe(1);
      expect(denied.stderr).toContain("[PI_CONTROLLER_PROVIDER_AUTH_UNSUPPORTED]");
      await expect(readFile(dnsCalls, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(observedHeaders).toEqual([]);

      const allowed = await run(false);
      expect(allowed.exitCode, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain("Protected provider reply");
      const announcements = allowed.stderr
        .split("\n")
        .filter((line) => line.startsWith("[PIONEER_NETWORK]"));
      expect(announcements).toHaveLength(1);
      expect(announcements[0]).toContain("provider-only. Provider hosts: none.");
      expect(announcements[0]).toContain(`Controller provider host: ${hostname}.`);
      expect(announcements[0]).not.toContain("127.0.0.1");
      expect(await readFile(dnsCalls, "utf8")).toContain(`${hostname}\n`);
      expect(observedHeaders).toEqual([`Bearer ${modelSecret}`]);
      expect(await readFile(path.join(workspace.piHome, "auth.json"), "utf8")).toBe(sourceAuth);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
      await workspace.remove();
    }
  },
);
