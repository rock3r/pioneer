import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { EgressTargetResolver } from "./eval-run/public-egress-proxy.js";

export interface PiAuthBroker {
  readonly environment: Readonly<Record<string, string>>;
  resolveWith(fallback: EgressTargetResolver): EgressTargetResolver;
  close(): Promise<void>;
}

// This endpoint accepts a provider name, never a credential or a file to write back.
export async function startPiAuthBroker(
  providers: ReadonlySet<string>,
  refresh: (provider: string) => Promise<unknown>,
): Promise<PiAuthBroker> {
  const hostname = `${randomUUID()}.pioneer-auth.invalid`;
  const token = randomUUID();
  let closing = false;
  let active: Promise<unknown> | undefined;
  let pending = 0;
  const server = createServer({ maxHeaderSize: 4096 }, async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end();
      return;
    }
    const provider = (request.url ?? "").slice("/oauth/".length);
    if (
      request.method !== "GET" ||
      !request.url?.startsWith("/oauth/") ||
      !providers.has(provider)
    ) {
      response.writeHead(400).end();
      return;
    }
    if (pending >= 8) {
      response.writeHead(429).end();
      return;
    }
    pending++;
    const operation = (active ?? Promise.resolve()).catch(() => {}).then(() => refresh(provider));
    active = operation;
    try {
      const credential = await operation;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(credential));
    } catch {
      response.writeHead(502).end("PI_OAUTH_REFRESH_FAILED");
    } finally {
      pending--;
      if (active === operation) active = undefined;
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Auth broker unavailable");
  const port = address.port;
  return {
    environment: {
      PIONEER_AUTH_BROKER_URL: `http://${hostname}:${port}`,
      PIONEER_AUTH_BROKER_TOKEN: token,
      PIONEER_AUTH_BROKER_PROVIDERS: JSON.stringify([...providers]),
    },
    resolveWith: (fallback) => async (requestedHost, requestedPort) => {
      if (requestedHost !== hostname) return fallback(requestedHost, requestedPort);
      if (closing || requestedPort !== port) throw new Error("Invalid auth broker destination");
      return { address: "127.0.0.1", family: 4 };
    },
    async close() {
      closing = true;
      // Finish any rotation and its durable write before destroying private worker state.
      await active?.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
