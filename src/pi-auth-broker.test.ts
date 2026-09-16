import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startPiAuthBroker } from "./pi-auth-broker.js";

describe("Pi authentication broker", () => {
  it("serializes concurrent refreshes instead of rejecting the second provider", async () => {
    let active = 0;
    let maximum = 0;
    const broker = await startPiAuthBroker(new Set(["first", "second"]), async (provider) => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return { provider };
    });
    try {
      const url = new URL(broker.environment.PIONEER_AUTH_BROKER_URL ?? "");
      url.hostname = "127.0.0.1";
      const responses = await Promise.all(
        ["first", "second"].map((provider) =>
          fetch(`${url.origin}/oauth/${provider}`, {
            headers: { authorization: `Bearer ${broker.environment.PIONEER_AUTH_BROKER_TOKEN}` },
          }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(maximum).toBe(1);
    } finally {
      await broker.close();
    }
  });
  it("accepts only an authenticated configured provider and pins the proxy destination port", async () => {
    const refresh = vi.fn(async () => ({ type: "oauth", access: "fixture-access" }));
    const broker = await startPiAuthBroker(new Set(["fixture", "fixture:@+/id"]), refresh);
    const url = new URL(broker.environment.PIONEER_AUTH_BROKER_URL ?? "");
    const fallback = vi.fn(async () => ({ address: "192.0.2.1", family: 4 as const }));
    const resolve = broker.resolveWith(fallback);
    const call = async (
      pathname: string,
      token = broker.environment.PIONEER_AUTH_BROKER_TOKEN,
      method = "GET",
    ): Promise<{ status: number; body: string }> =>
      await new Promise((done, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: url.port,
            path: pathname,
            method,
            headers: { authorization: `Bearer ${token}` },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => done({ status: response.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      await expect(resolve(url.hostname, Number(url.port))).resolves.toEqual({
        address: "127.0.0.1",
        family: 4,
      });
      await expect(resolve(url.hostname, Number(url.port) + 1)).rejects.toThrow(
        "Invalid auth broker destination",
      );
      await resolve("example.com", 443);
      expect(fallback).toHaveBeenCalledWith("example.com", 443);
      expect((await call("/oauth/fixture", "wrong")).status).toBe(403);
      expect((await call("/oauth/unknown")).status).toBe(400);
      expect((await call("/oauth/fixture?credential=forged")).status).toBe(400);
      expect((await call("/oauth/fixture", undefined, "POST")).status).toBe(400);
      expect(refresh).not.toHaveBeenCalled();
      const result = await call("/oauth/fixture");
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ type: "oauth", access: "fixture-access" });
      expect(refresh).toHaveBeenCalledExactlyOnceWith("fixture");
      expect((await call(`/oauth/${encodeURIComponent("fixture:@+/id")}`)).status).toBe(200);
      expect(refresh).toHaveBeenLastCalledWith("fixture:@+/id");
      expect((await call("/oauth/%ZZ")).status).toBe(400);
      refresh.mockRejectedValueOnce(new Error("secret-provider-error"));
      expect(await call("/oauth/fixture")).toEqual({
        status: 502,
        body: "PI_OAUTH_REFRESH_FAILED",
      });
    } finally {
      await broker.close();
    }
    await expect(resolve(url.hostname, Number(url.port))).rejects.toThrow(
      "Invalid auth broker destination",
    );
  });
});
