const MIB_BYTES = 1024 * 1024;
export const MIN_RPC_OUTPUT_BYTES = 1 * MIB_BYTES;
export const DEFAULT_RPC_OUTPUT_BYTES = 20 * MIB_BYTES;
export const MAX_RPC_OUTPUT_BYTES = 64 * MIB_BYTES;
const MIN_RPC_OUTPUT_MIB = MIN_RPC_OUTPUT_BYTES / MIB_BYTES;
const MAX_RPC_OUTPUT_MIB = MAX_RPC_OUTPUT_BYTES / MIB_BYTES;

export function validateRpcOutputLimitMiB(maxRpcOutputMiB: number | undefined): number {
  if (maxRpcOutputMiB === undefined) return DEFAULT_RPC_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxRpcOutputMiB) ||
    maxRpcOutputMiB < MIN_RPC_OUTPUT_MIB ||
    maxRpcOutputMiB > MAX_RPC_OUTPUT_MIB
  ) {
    throw new Error(
      `RPC output limit must be an integral value from ${MIN_RPC_OUTPUT_MIB} through ${MAX_RPC_OUTPUT_MIB} MiB`,
    );
  }
  return maxRpcOutputMiB * MIB_BYTES;
}

export function validateRpcOutputBytes(maxRpcOutputBytes: number | undefined): number {
  // The API accepts integral bytes, but deliberately keeps a 1 MiB floor like the CLI.
  if (maxRpcOutputBytes === undefined) return DEFAULT_RPC_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxRpcOutputBytes) ||
    maxRpcOutputBytes < MIN_RPC_OUTPUT_BYTES ||
    maxRpcOutputBytes > MAX_RPC_OUTPUT_BYTES
  ) {
    throw new Error(
      `RPC output byte limit must be an integral value from ${MIN_RPC_OUTPUT_BYTES} through ${MAX_RPC_OUTPUT_BYTES} bytes`,
    );
  }
  return maxRpcOutputBytes;
}

export function rpcOutputLimitDiagnostic(limitBytes: number): string {
  const limitMiB = limitBytes / MIB_BYTES;
  const limit = Number.isInteger(limitMiB) ? `${limitMiB} MiB` : `${limitBytes} bytes`;
  return `[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the ${limit} limit`;
}
