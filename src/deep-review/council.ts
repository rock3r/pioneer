export interface DeepReviewTaskRunner {
  run<T>(tasks: readonly (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]>;
}

export const defaultDeepReviewTaskRunner: DeepReviewTaskRunner = {
  async run(tasks) {
    return Promise.allSettled(tasks.map((task) => task()));
  },
};

export interface BoundedConcurrencyOptions {
  readonly maximumParallel: number;
  readonly signal?: AbortSignal;
}

export async function runWithBoundedConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  options: BoundedConcurrencyOptions,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(options.maximumParallel, tasks.length) },
    async () => {
      while (nextIndex < tasks.length) {
        if (options.signal?.aborted) {
          throw new Error("[DEEP_REVIEW_WORKER_FAILED] deep review cancelled");
        }
        const current = nextIndex;
        nextIndex += 1;
        const task = tasks[current];
        if (task === undefined) continue;
        try {
          const value = await task();
          results[current] = { status: "fulfilled", value };
        } catch (reason) {
          results[current] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type WorkerActorStatus = "success" | "failed" | "timed-out" | "output-invalid";

export interface WorkerActorOutcome {
  readonly memberId: string;
  readonly model: string;
  readonly independenceGroup: string;
  readonly status: WorkerActorStatus;
  readonly candidateIds?: readonly string[];
  readonly diagnosticId?: string;
}

export interface WorkerExecutionResult {
  readonly candidateIds: readonly string[];
}

export function settledWorkerOutcome(
  member: { readonly id: string; readonly model: string; readonly independenceGroup: string },
  result: PromiseSettledResult<WorkerExecutionResult>,
  diagnosticPrefix: string,
): WorkerActorOutcome {
  if (result.status === "rejected") {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    const status: WorkerActorStatus = message.includes("REVIEW_TIMEOUT")
      ? "timed-out"
      : message.includes("DEEP_REVIEW_OUTPUT_INVALID")
        ? "output-invalid"
        : "failed";
    return {
      memberId: member.id,
      model: member.model,
      independenceGroup: member.independenceGroup,
      status,
      diagnosticId: `${diagnosticPrefix}-${member.id}`,
    };
  }
  return {
    memberId: member.id,
    model: member.model,
    independenceGroup: member.independenceGroup,
    status: "success",
    candidateIds: result.value.candidateIds,
  };
}
