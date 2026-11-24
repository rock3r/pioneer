import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { EgressPolicy } from "./eval-run/egress-policy.js";
import {
  type ProtectedProviderNetwork,
  prepareProtectedProviderNetwork,
} from "./eval-run/provider-network.js";
import { thinkingFromModelShorthand } from "./pi-model-selection.js";
import { PI_PROVIDER_FIELD } from "./pi-provider-id.js";
import { type ProviderAuthGateway, startProviderAuthGateway } from "./provider-auth-gateway.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const API_ROUTES = {
  "openai-completions": { suffix: "/chat/completions", header: "authorization" },
  "openai-responses": { suffix: "/responses", header: "authorization" },
  "anthropic-messages": { suffix: "/v1/messages", header: "x-api-key", optionalQuery: "beta=true" },
} as const;

export function unsupportedControllerProviderAuth(detail: string): Error {
  return new Error(`[PI_CONTROLLER_PROVIDER_AUTH_UNSUPPORTED] ${detail}`);
}

export interface ControllerProviderAuth {
  readonly gateway: ProviderAuthGateway;
  readonly files: { readonly auth: string; readonly models: string };
  readonly upstreamHostname: string;
  readonly upstreamPort: 443;
  readonly providerNetwork: ProtectedProviderNetwork;
}

export async function assertControllerProviderAuthOutsideGrants(
  sourceDir: string,
  grants: readonly string[],
): Promise<void> {
  const protectedFiles = ["auth.json", "models.json", "models-store.json", "settings.json"];
  for (const grant of new Set(grants)) {
    const canonical = await realpath(grant);
    for (const name of protectedFiles) {
      const relative = path.relative(canonical, path.join(sourceDir, name));
      if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..")
        throw unsupportedControllerProviderAuth(
          "An actor runtime grant includes the original provider configuration",
        );
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseConfig(contents: string): Record<string, unknown> {
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) throw new Error("Configuration too large");
  const parsed = record(JSON.parse(contents.replace(/^\uFEFF/, "")));
  if (parsed === undefined) throw new Error("Configuration must be an object");
  return parsed;
}

async function readConfig(
  sourceDir: string,
  filename: "models.json" | "auth.json",
): Promise<Record<string, unknown>> {
  try {
    const handle = await open(
      path.join(sourceDir, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_CONFIG_BYTES)
        throw new Error("Invalid config file");
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return parseConfig(bytes.subarray(0, offset).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (filename === "auth.json" && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw unsupportedControllerProviderAuth(
      `Use a valid, regular ${filename} in the selected Pi home`,
    );
  }
}

function requireCredential(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/=-]{8,4096}$/.test(value))
    throw unsupportedControllerProviderAuth(
      "Configure a standard header credential for the requested provider",
    );
  return value;
}

function resolveKey(configured: unknown, storedEnvironment: unknown): string {
  if (typeof configured !== "string") return requireCredential(configured);
  if (configured.startsWith("!"))
    throw unsupportedControllerProviderAuth(
      "Configure a literal or environment-backed provider key",
    );
  const env = record(storedEnvironment);
  const resolved = configured.replace(
    /\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match: string, token: string, braced: string | undefined, bare: string | undefined) => {
      if (token === "$" || token === "!") return token;
      const name = braced ?? bare ?? "";
      const stored = env?.[name];
      const value = typeof stored === "string" && stored.length > 0 ? stored : process.env[name];
      if (!value)
        throw unsupportedControllerProviderAuth(
          "Set the provider key environment variable before retrying",
        );
      return value;
    },
  );
  return requireCredential(resolved);
}

export async function prepareControllerProviderAuth(
  sourceDir: string,
  requestedModel: string | undefined,
  policy: EgressPolicy = { network: "public" },
): Promise<ControllerProviderAuth> {
  const input = requestedModel?.trim() ?? "";
  const qualified =
    thinkingFromModelShorthand(input) === undefined
      ? input
      : input.slice(0, input.lastIndexOf(":"));
  const delimiter = qualified.indexOf("/");
  const provider = qualified.slice(0, delimiter);
  const model = qualified.slice(delimiter + 1);
  if (
    delimiter < 1 ||
    !PI_PROVIDER_FIELD.test(provider) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(model)
  )
    throw unsupportedControllerProviderAuth("Select an exact PROVIDER/MODEL with --model");
  const config = await readConfig(sourceDir, "models.json");
  const configured = record(record(config.providers)?.[provider]);
  const models = Array.isArray(configured?.models)
    ? configured.models.map(record).filter((entry) => entry?.id === model)
    : [];
  const selected = models.length === 1 ? models[0] : undefined;
  const api = selected?.api ?? configured?.api;
  if (selected === undefined || typeof api !== "string" || !Object.hasOwn(API_ROUTES, api)) {
    throw unsupportedControllerProviderAuth(
      "Declare the selected model and a supported API in models.json",
    );
  }
  const override = record(record(configured?.modelOverrides)?.[model]);
  if (
    configured?.headers !== undefined ||
    selected.headers !== undefined ||
    override?.headers !== undefined ||
    configured?.authHeader === true ||
    configured?.oauth !== undefined ||
    selected.apiKey !== undefined
  ) {
    throw unsupportedControllerProviderAuth(
      "Custom configured headers and authentication overrides are not supported in this mode",
    );
  }
  let upstream: URL;
  try {
    const base = selected.baseUrl ?? configured?.baseUrl;
    if (typeof base !== "string" || !/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?$/i.test(base))
      throw new Error();
    upstream = new URL(base);
  } catch {
    throw unsupportedControllerProviderAuth(
      "Set a public HTTPS provider baseUrl without credentials, query, or fragment",
    );
  }
  const auth = await readConfig(sourceDir, "auth.json");
  const stored = record(auth[provider]);
  const oauth = stored?.type === "oauth";
  if (
    oauth &&
    (api === "anthropic-messages" || provider === "openai-codex" || provider === "github-copilot")
  )
    throw unsupportedControllerProviderAuth(
      "This provider uses a specialized OAuth transport. Configure a supported API key or standard bearer provider",
    );
  if (stored !== undefined && !oauth && stored.type !== "api_key")
    throw unsupportedControllerProviderAuth(
      "The configured credential requires an unsupported authentication transport",
    );
  const credential = oauth
    ? async (): Promise<string> => {
        const current = record((await readConfig(sourceDir, "auth.json"))[provider]);
        if (current?.type !== "oauth" || typeof current.expires !== "number")
          throw unsupportedControllerProviderAuth("The provider OAuth credential is unavailable");
        if (current.expires <= Date.now())
          throw unsupportedControllerProviderAuth(
            "Renew the provider OAuth login with Pi before retrying",
          );
        return requireCredential(current.access);
      }
    : async (): Promise<string> => resolveKey(stored?.key ?? configured?.apiKey, stored?.env);
  await credential();
  const route = API_ROUTES[api as keyof typeof API_ROUTES];
  const providerNetwork = prepareProtectedProviderNetwork(policy, upstream.hostname, qualified);
  const gateway = await startProviderAuthGateway(
    {
      upstream,
      suffix: route.suffix,
      ...("optionalQuery" in route ? { optionalQuery: route.optionalQuery } : {}),
      model,
      actorHeader: route.header,
      upstreamHeader: oauth ? "authorization" : route.header,
      credential,
    },
    providerNetwork.resolveUpstream,
  );
  return {
    gateway,
    providerNetwork,
    upstreamHostname: upstream.hostname,
    upstreamPort: 443,
    files: {
      auth: JSON.stringify({ [provider]: { type: "api_key", key: gateway.placeholder } }),
      models: JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: gateway.baseUrl,
            api,
            apiKey: gateway.placeholder,
            models: [
              {
                id: model,
                ...(typeof selected.reasoning === "boolean"
                  ? { reasoning: selected.reasoning }
                  : {}),
                ...(Array.isArray(selected.input)
                  ? {
                      input: selected.input.filter(
                        (value) => value === "text" || value === "image",
                      ),
                    }
                  : {}),
                ...(Number.isSafeInteger(selected.contextWindow)
                  ? { contextWindow: selected.contextWindow }
                  : {}),
                ...(Number.isSafeInteger(selected.maxTokens)
                  ? { maxTokens: selected.maxTokens }
                  : {}),
              },
            ],
          },
        },
      }),
    },
  };
}
