import { describe, expect, it } from "vitest";
import {
  formatLoopbackTarget,
  parseActorEnvironment,
  parseLoopbackTargets,
} from "./actor-options.js";

describe("eval --allow-loopback targets (#88)", () => {
  it("accepts exact IPv4 loopback ports and deduplicates them", () => {
    expect(
      parseLoopbackTargets(["127.0.0.1:8722", "localhost:8723", "127.0.0.1:8722"], "darwin"),
    ).toEqual([8722, 8723]);
  });

  it("formats a port for diagnostics and work logs", () => {
    expect(formatLoopbackTarget(8722)).toBe("127.0.0.1:8722");
  });

  it.each([
    "8722",
    "127.0.0.1",
    "127.0.0.1:",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:+80",
    "127.0.0.1:080",
    "127.0.0.1:80-90",
    "127.0.0.1:*",
    "127.0.0.2:8722",
    "10.0.0.1:8722",
    "192.168.1.10:8722",
    "0.0.0.0:8722",
    "example.com:443",
    "[::1]:8722",
    "::1:8722",
    "localhost.:8722",
  ])("rejects a target that is not one exact IPv4 loopback port: %s", (value) => {
    expect(() => parseLoopbackTargets([value], "darwin")).toThrow(/EVAL_LOOPBACK_TARGET_INVALID/);
  });

  it("reserves the Linux in-namespace proxy relay port", () => {
    expect(() => parseLoopbackTargets(["127.0.0.1:3128"], "linux")).toThrow(
      /EVAL_LOOPBACK_TARGET_INVALID.*3128/,
    );
    expect(parseLoopbackTargets(["127.0.0.1:3128"], "darwin")).toEqual([3128]);
  });
});

describe("eval --env actor variables (#89)", () => {
  it("parses NAME=VALUE pairs, keeping everything after the first equals sign", () => {
    expect(
      parseActorEnvironment(["CAV_SPOOL=/runs/spool", "MCP_ARGS=--flag=value", "EMPTY="]),
    ).toEqual({ CAV_SPOOL: "/runs/spool", MCP_ARGS: "--flag=value", EMPTY: "" });
  });

  it.each(["NO_EQUALS", "=value", "1ABC=value", "BAD-NAME=value", "SPACE NAME=value", "NUL=a\0b"])(
    "rejects a malformed variable: %j",
    (value) => {
      expect(() => parseActorEnvironment([value])).toThrow(/EVAL_ACTOR_ENV_INVALID/);
    },
  );

  it.each([
    "PATH",
    "path",
    "HOME",
    "TMPDIR",
    "USERPROFILE",
    "HTTP_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "NO_PROXY",
    "no_proxy",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
    "PI_CODING_AGENT_DIR",
    "PI_OFFLINE",
    "PIONEER_AUTH_BROKER_TOKEN",
    "PIONEER_HOST_SECRET",
  ])("refuses to override a variable Pioneer controls: %s", (name) => {
    expect(() => parseActorEnvironment([`${name}=override`])).toThrow(
      new RegExp(`EVAL_ACTOR_ENV_INVALID.*${name}`),
    );
  });

  it("rejects a variable named twice instead of guessing which value wins", () => {
    expect(() => parseActorEnvironment(["CAV_SPOOL=/a", "CAV_SPOOL=/b"])).toThrow(
      /EVAL_ACTOR_ENV_INVALID.*CAV_SPOOL.*more than once/,
    );
  });

  it("bounds the number and size of variables", () => {
    expect(() =>
      parseActorEnvironment(Array.from({ length: 65 }, (_, index) => `NAME_${index}=x`)),
    ).toThrow(/EVAL_ACTOR_ENV_INVALID.*64/);
    expect(() => parseActorEnvironment([`BIG=${"x".repeat(32 * 1024 + 1)}`])).toThrow(
      /EVAL_ACTOR_ENV_INVALID.*BIG/,
    );
  });

  it("never echoes a rejected value", () => {
    expect(() => parseActorEnvironment(["PIONEER_TOKEN=super-secret-value"])).toThrow(
      /^(?!.*super-secret-value)/s,
    );
  });
});
