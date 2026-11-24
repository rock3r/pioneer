import { open } from "node:fs/promises";
import path from "node:path";
import { thinkingFromModelShorthand } from "../pi-model-selection.js";
import {
  createControllerProviderResolver,
  createEgressResolver,
  type EgressPolicy,
  type ResolverSources,
} from "./egress-policy.js";
import type { EgressTargetResolver } from "./public-egress-proxy.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid provider configuration");
  return value as Record<string, unknown>;
}

async function config(dir: string, name: string): Promise<Record<string, unknown>> {
  const handle = await open(path.join(dir, name), "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return {};
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid provider configuration");
    return record(JSON.parse(await handle.readFile("utf8")));
  } catch {
    throw new Error("Cannot determine provider endpoint from Pi configuration");
  } finally {
    await handle.close();
  }
}

const standardHosts = new Map([
  ["openai", "api.openai.com"],
  ["openai-codex", "chatgpt.com"],
  ["anthropic", "api.anthropic.com"],
  ["google", "generativelanguage.googleapis.com"],
  ["openrouter", "openrouter.ai"],
  ["mistral", "api.mistral.ai"],
  ["groq", "api.groq.com"],
  ["xai", "api.x.ai"],
  ["deepseek", "api.deepseek.com"],
]);

// Pi's built-in OAuth refresh endpoints can differ from its model API endpoints.
const oauthIssuers = new Map([
  ["anthropic", "platform.claude.com"],
  ["openai", "auth.openai.com"],
  ["openai-codex", "auth.openai.com"],
  ["xai", "auth.x.ai"],
]);

export interface PreparedProviderNetwork {
  readonly policy: EgressPolicy;
  readonly defaultModel: string | undefined;
  bind(resolvedModel: string | undefined): void;
  workerPolicy(provider: string): EgressPolicy;
}

export interface ProtectedProviderNetwork extends PreparedProviderNetwork {
  readonly resolveUpstream: EgressTargetResolver;
}

export function prepareProtectedProviderNetwork(
  policy: EgressPolicy,
  upstreamHostname: string,
  requestedModel: string,
  sources?: ResolverSources,
): ProtectedProviderNetwork {
  const requested = requestedModel.trim();
  const thinking = thinkingFromModelShorthand(requested);
  const model = thinking === undefined ? requested : requested.slice(0, -thinking.length - 1);
  if (model.indexOf("/") < 1 || model.endsWith("/")) {
    throw new Error("Protected provider networking requires a qualified model");
  }
  const filters = {
    network: policy.network,
    ...(policy.allowHosts === undefined ? {} : { allowHosts: [...policy.allowHosts] }),
    ...(policy.blockHosts === undefined ? {} : { blockHosts: [...policy.blockHosts] }),
  };
  const upstream = createControllerProviderResolver(filters, upstreamHostname, sources);
  const actorPolicy = { ...filters, controllerProviderHost: upstream.hostname };
  return {
    policy: actorPolicy,
    defaultModel: model,
    resolveUpstream: upstream.resolve,
    bind(resolvedModel) {
      if (resolvedModel?.toLowerCase() !== model.toLowerCase()) {
        throw new Error("Resolved Pi model differs from the protected provider model");
      }
    },
    workerPolicy: () => actorPolicy,
  };
}

function configuredModels(entry: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(entry.models) ? entry.models.map(record) : [];
}

function selectProvider(
  requested: string | undefined,
  providers: Record<string, unknown>,
  settings: Record<string, unknown>,
) {
  if (requested === undefined) return settings.defaultProvider;
  const names = [...new Set([...Object.keys(providers), ...standardHosts.keys()])];
  const qualified = names
    .filter((name) => requested.toLowerCase().startsWith(`${name.toLowerCase()}/`))
    .sort((a, b) => b.length - a.length);
  if (qualified[0]) return qualified[0];
  const owners = Object.entries(providers).filter(([, entry]) =>
    configuredModels(record(entry)).some(
      (model) => typeof model.id === "string" && model.id.toLowerCase() === requested.toLowerCase(),
    ),
  );
  return owners.length === 1 ? owners[0]?.[0] : undefined;
}

function resolveProviderEndpoint(
  policy: EgressPolicy,
  settings: Record<string, unknown>,
  providers: Record<string, unknown>,
  requested: string | undefined,
  discovery: boolean,
): { policy: EgressPolicy; provider?: string } {
  const trimmed = requested?.trim();
  const thinking = trimmed && thinkingFromModelShorthand(trimmed);
  const selection = thinking ? trimmed?.slice(0, -thinking.length - 1) : trimmed;
  const provider = selectProvider(selection, providers, settings);
  if (typeof provider !== "string" || !provider) {
    if (discovery || policy.allowHosts?.length) return { policy };
    throw new Error(
      "Cannot determine the provider endpoint. Specify a qualified provider/model, configure a Pi defaultProvider, or pass --allow-host.",
    );
  }
  const entry = Object.hasOwn(providers, provider) ? record(providers[provider]) : {};
  const modelId = selection?.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? selection.slice(provider.length + 1)
    : (selection ?? settings.defaultModel);
  const model = configuredModels(entry).find(
    (candidate) =>
      typeof modelId === "string" &&
      typeof candidate.id === "string" &&
      candidate.id.toLowerCase() === modelId.toLowerCase(),
  );
  const endpoint = model?.baseUrl ?? entry.baseUrl;
  let host = standardHosts.get(provider);
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") throw new Error("Invalid provider endpoint");
    const url = URL.parse(endpoint);
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hostname.includes("*") ||
      !url.hostname
    )
      throw new Error("Invalid provider endpoint");
    host = url.hostname;
  }
  if (!host) {
    if (discovery || policy.allowHosts?.length) return { policy, provider };
    throw new Error(
      "Unknown provider endpoint. Configure models.json baseUrl or pass --allow-host.",
    );
  }
  return { policy: { ...policy, providerHosts: [host] }, provider };
}

export async function prepareProviderNetwork(
  policy: EgressPolicy,
  agentDir: string,
  requested?: string,
): Promise<PreparedProviderNetwork> {
  createEgressResolver(policy);
  if (policy.network !== "provider-only") {
    return { policy, defaultModel: undefined, bind: () => {}, workerPolicy: () => policy };
  }
  // Discovery can write its private Pi home. Bind the final route from the original snapshot.
  const settings = await config(agentDir, "settings.json");
  const models = await config(agentDir, "models.json");
  const providers = record(models.providers ?? {});
  const defaultModel =
    typeof settings.defaultProvider === "string" &&
    typeof settings.defaultModel === "string" &&
    settings.defaultProvider &&
    settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : undefined;
  let current = resolveProviderEndpoint(policy, settings, providers, requested, true);
  return {
    get policy() {
      return current.policy;
    },
    defaultModel,
    bind(resolvedModel) {
      current = resolveProviderEndpoint(
        policy,
        settings,
        providers,
        resolvedModel ?? requested,
        false,
      );
    },
    workerPolicy(provider) {
      const issuer = provider === current.provider ? oauthIssuers.get(provider) : undefined;
      return issuer === undefined ? current.policy : { ...current.policy, oauthIssuerHost: issuer };
    },
  };
}

export function describeEgressPolicy(policy: EgressPolicy): string {
  const rules = (list: readonly string[] | undefined) => list?.join(", ") || "none";
  return (
    "[PIONEER_NETWORK] " +
    policy.network +
    ". Provider hosts: " +
    rules(policy.providerHosts) +
    (policy.controllerProviderHost === undefined
      ? ""
      : `. Controller provider host: ${policy.controllerProviderHost}`) +
    ". Allow: " +
    rules(policy.allowHosts) +
    ". Block: " +
    rules(policy.blockHosts) +
    ". Local host and metadata destinations are blocked. " +
    (policy.network === "provider-only" ? "Other web and registry lookups are blocked." : "")
  );
}
