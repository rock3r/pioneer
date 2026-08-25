export type WorkerOutcomeV1 =
  | {
      readonly memberId: string;
      readonly model: string;
      readonly independenceGroup: string;
      readonly status: "success";
      readonly candidateIds: readonly string[];
    }
  | {
      readonly memberId: string;
      readonly model: string;
      readonly independenceGroup: string;
      readonly status: "failed" | "timed-out" | "output-invalid";
      readonly diagnosticId: string;
    };

export type PresidentOutcomeV1 =
  | {
      readonly memberId: string;
      readonly model: string;
      readonly status: "success";
      readonly clusterCount: number;
    }
  | {
      readonly memberId: string;
      readonly model: string;
      readonly status: "not-run" | "failed" | "timed-out" | "output-invalid";
      readonly diagnosticId: string;
    };
