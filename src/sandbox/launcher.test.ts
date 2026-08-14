import { describe, expect, it } from "vitest";
import { buildLinuxSandboxArgv, buildMacosSandboxArgv } from "./launcher.js";

const policy = {
  readOnlyPaths: ["/repo", "/repo/.idea", "/repo/.vscode", "/usr"],
  writablePaths: ["/scratch"],
  network: "proxy" as const,
  proxyUrl: "http://pioneer:secret@127.0.0.1:43123",
};

describe("direct sandbox launchers", () => {
  it("generates a macOS profile from only caller-provided grants", () => {
    const launch = buildMacosSandboxArgv(policy, ["/usr/bin/node", "actor.mjs"]);
    expect(launch.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(launch.profile).toContain('(allow file-read* (subpath "/repo/.idea"))');
    expect(launch.profile).toContain('(allow file-read* (subpath "/repo/.vscode"))');
    expect(launch.profile).toContain('(allow file-read-metadata (literal "/repo"))');
    expect(launch.profile).not.toContain("(allow file-read-metadata)\n");
    expect(launch.profile).not.toContain("dangerous");
    expect(launch.profile).toContain('(allow network-outbound (remote ip "localhost:43123"))');
    expect(launch.argv.slice(-2)).toEqual(["/usr/bin/node", "actor.mjs"]);
  });

  it("builds a Linux rootless mount namespace without exposing the host root", () => {
    const launch = buildLinuxSandboxArgv(
      policy,
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
      "/scratch/egress.sock",
    );
    expect(launch.argv[0]).toBe("/usr/bin/bwrap");
    expect(launch.argv).toContain("--unshare-user");
    expect(launch.argv).toContain("--unshare-pid");
    expect(launch.argv).toContain("--unshare-net");
    expect(launch.argv.join("\0")).not.toContain("--ro-bind\0/\0/");
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--ro-bind", "/repo/.idea", "/repo/.idea"]),
    );
    expect(launch.argv).toEqual(expect.arrayContaining(["--bind", "/scratch", "/scratch"]));
    expect(launch.argv).not.toContain("/bin/sh");
    expect(launch.argv.some((entry) => entry.endsWith("linux-network-supervisor.js"))).toBe(true);
  });

  it("leaves networking absent when the policy is offline", () => {
    const offline = {
      readOnlyPaths: policy.readOnlyPaths,
      writablePaths: policy.writablePaths,
      network: "none" as const,
    };
    const mac = buildMacosSandboxArgv(offline, ["/usr/bin/true"]);
    const linux = buildLinuxSandboxArgv(offline, ["/usr/bin/true"], "/usr/bin/bwrap");
    expect(mac.profile).not.toContain("network-outbound");
    expect(linux.argv).toContain("--unshare-net");
  });

  it("rewrites only the Linux runtime executable slot", () => {
    const runtime = "/opt/node/bin/node";
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none" },
      [runtime, runtime, "actor.mjs"],
      "/usr/bin/bwrap",
      undefined,
      runtime,
    );

    expect(launch.argv.slice(-3)).toEqual(["/pioneer-runtime/bin/node", runtime, "actor.mjs"]);
  });

  it("can prohibit child-process creation for a controller-owned review", () => {
    const launch = buildMacosSandboxArgv({ ...policy, allowProcessFork: false }, [
      "/usr/bin/node",
      "actor.mjs",
    ]);
    expect(launch.profile).not.toContain("(allow process-fork)");
  });

  it.each([
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:43123",
    "http://user@127.0.0.1:43123",
  ])("rejects an unauthenticated or invalid proxy URL: %s", (proxyUrl) => {
    expect(() => buildMacosSandboxArgv({ ...policy, proxyUrl }, ["/usr/bin/true"])).toThrow(
      /authenticated loopback HTTP URL/i,
    );
  });
});
