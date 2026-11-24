import { lookup } from "node:dns/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { isPublicInternetAddress } from "./isolation.js";
import type { EgressTargetResolver } from "./public-egress-proxy.js";

export type NetworkTier = "full" | "public" | "provider-only";
export interface EgressPolicy {
  readonly network: NetworkTier;
  readonly allowHosts?: readonly string[];
  readonly blockHosts?: readonly string[];
  readonly providerHosts?: readonly string[];
  readonly oauthIssuerHost?: string;
}

const metadataNames = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const localSuffixes = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];
const validHostname =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function normalized(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[([^\]]+)\]$/, "$1")
    .replace(/\.$/, "");
}

function family(address: string): "ipv4" | "ipv6" {
  return net.isIPv4(address) ? "ipv4" : "ipv6";
}

function rules(patterns: readonly string[]) {
  if (patterns.length > 256) throw new Error("Too many network host filters");
  const networks = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
  const names = new Set<string>();
  const suffixes: string[] = [];
  for (const raw of patterns) {
    const pattern = normalized(raw);
    const [address = "", prefix, ...extra] = pattern.split("/");
    const version = net.isIP(address);
    if (version !== 0 && !address.includes("%") && extra.length === 0) {
      if (prefix === undefined) networks[family(address)].addAddress(address, family(address));
      else {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128))
          throw new Error("Invalid network CIDR filter");
        networks[family(address)].addSubnet(address, Number(prefix), family(address));
      }
      continue;
    }
    const wildcard = pattern.startsWith("*.");
    const name = wildcard ? pattern.slice(2) : pattern;
    if (!validHostname.test(name) || /^[\d.]+$/.test(name))
      throw new Error("Invalid network host filter");
    if (wildcard) suffixes.push("." + name);
    else names.add(name);
  }
  return {
    address: (ip: string) => networks[family(ip)].check(ip, family(ip)),
    hostname: (name: string) => names.has(name) || suffixes.some((suffix) => name.endsWith(suffix)),
  };
}

const hardFloor = rules([
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "168.63.129.16",
  "100.100.100.200",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "2002::/16",
  "2001::/32",
  "fe80::/10",
  "ff00::/8",
  "fd00:ec2::254",
]);
interface ResolverSources {
  lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
  interfaces(): readonly string[];
}

const systemSources: ResolverSources = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  interfaces: () =>
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map((entry) => entry.address.split("%")[0] ?? ""),
    ),
};

export function createEgressResolver(
  policy: EgressPolicy,
  sources: ResolverSources = systemSources,
): EgressTargetResolver {
  if (!["full", "public", "provider-only"].includes(policy.network))
    throw new Error("Unsupported network tier");
  const allow = rules(policy.allowHosts ?? []);
  const block = rules(policy.blockHosts ?? []);
  const provider = rules(policy.providerHosts ?? []);
  let local: net.BlockList | undefined;
  let refreshAfter = 0;
  function liveInterfaces(): net.BlockList {
    if (local && performance.now() < refreshAfter) return local;
    const addresses = sources.interfaces();
    if (addresses.length === 0) throw new Error("Network interface inventory unavailable");
    const list = new net.BlockList();
    for (const address of addresses) list.addAddress(address, family(address));
    local = list;
    refreshAfter = performance.now() + 1000;
    return list;
  }
  return async (hostname, port) => {
    const host = normalized(hostname);
    const version = net.isIP(host);
    const denied = () => new Error("Network destination is not allowed");
    if (
      metadataNames.has(host) ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.includes("%")
    )
      throw denied();
    const issuer = port === 443 && host === policy.oauthIssuerHost;
    const grantedName = allow.hostname(host) || provider.hostname(host) || issuer;
    if (
      !version &&
      (!validHostname.test(host) ||
        block.hostname(host) ||
        (!grantedName &&
          (policy.network === "provider-only" ||
            (policy.network === "public" &&
              localSuffixes.some((suffix) => host.endsWith(suffix))))))
    )
      throw denied();
    const candidates = version ? [{ address: host, family: version }] : await sources.lookup(host);
    const first = candidates[0];
    if (!first) throw denied();
    const interfaces = liveInterfaces();
    for (const { address, family: reportedFamily } of candidates) {
      const ipVersion = net.isIP(address);
      if (
        !ipVersion ||
        reportedFamily !== ipVersion ||
        address.includes("%") ||
        hardFloor.address(address) ||
        interfaces.check(address, family(address)) ||
        block.address(address)
      )
        throw denied();
      if (grantedName || allow.address(address) || (version && provider.address(address))) continue;
      if (
        policy.network === "provider-only" ||
        (policy.network === "public" && !isPublicInternetAddress(address))
      )
        throw denied();
    }
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  };
}
