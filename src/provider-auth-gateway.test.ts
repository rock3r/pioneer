import http from "node:http";
import type https from "node:https";
import { expect, it, vi } from "vitest";
import { startProviderAuthGateway } from "./provider-auth-gateway.js";

it("limits credential injection to the configured model route and strips reflected secrets and redirects", async () => {
  const secret = "mock-oauth-access-token";
  const received = vi.fn();
  let redirect = false;
  const fakeProvider = http.createServer((request, response) => {
    received(request.headers);
    request.resume();
    if (redirect) {
      response.writeHead(302, { location: "https://other.invalid/path" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": `secret=${secret}`,
    });
    response.write(`data: ${secret.slice(0, 8)}`);
    setImmediate(() => response.end(`${secret.slice(8)}\n\n`));
  });
  await new Promise<void>((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
  const address = fakeProvider.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not bind test provider");
  const resolve = vi.fn(async () => ({ address: "93.184.216.34", family: 4 as const }));
  const send = vi.fn(
    (options: https.RequestOptions, listener: (response: http.IncomingMessage) => void) =>
      http.request({ ...options, host: "127.0.0.1", port: address.port }, listener),
  );
  const gateway = await startProviderAuthGateway(
    {
      upstream: new URL("https://configured.invalid/v1"),
      suffix: "/chat/completions",
      optionalQuery: "beta=true",
      model: "selected-model",
      actorHeader: "x-api-key",
      upstreamHeader: "authorization",
      credential: async () => secret,
    },
    resolve,
    send,
  );

  try {
    const endpoint = `${gateway.baseUrl}/chat/completions`;
    const call = async (
      url = endpoint,
      extraHeaders: Record<string, string> = {},
      model = "selected-model",
    ) =>
      await fetch(url, {
        method: "POST",
        headers: { "x-api-key": gateway.placeholder, ...extraHeaders },
        body: JSON.stringify({ model }),
      });
    expect((await call(`${gateway.baseUrl}/unrelated`)).status).toBe(404);
    expect((await call(`${endpoint}?beta=true&extra=true`)).status).toBe(404);
    expect((await call(endpoint, { "x-api-key": "fake-invalid-key" })).status).toBe(401);
    expect((await call(endpoint, { "x-reflect-credential": gateway.placeholder })).status).toBe(
      401,
    );
    expect((await call(endpoint, {}, "other-model")).status).toBe(400);
    expect(received).not.toHaveBeenCalled();

    const response = await call(endpoint, { "x-other": "actor-provided" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("data: [REDACTED]\n\n");
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: `Bearer ${secret}` }),
    );
    expect(received.mock.calls[0]?.[0]).not.toHaveProperty("x-api-key");
    expect(received.mock.calls[0]?.[0]).not.toHaveProperty("x-other");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("configured.invalid", 443);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "93.184.216.34",
        servername: "configured.invalid",
        path: "/v1/chat/completions",
      }),
      expect.any(Function),
    );
    const beta = await call(`${endpoint}?beta=true`);
    expect(beta.status).toBe(200);
    expect(await beta.text()).toBe("data: [REDACTED]\n\n");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/v1/chat/completions?beta=true" }),
      expect.any(Function),
    );

    redirect = true;
    const redirected = await call();
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    await gateway.close();
    fakeProvider.closeAllConnections();
    await new Promise<void>((done) => fakeProvider.close(() => done()));
  }
});
