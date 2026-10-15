/** Stage 3B proposal: decision logic only. Does not create jobs or generations. */
export type RetryEvidence = Readonly<{
  attemptId: string;
  generation: number;
  outcome: "NOT_SENT" | "REJECTED" | "CONFIRMED" | "UNKNOWN" | "AUTHORIZED" | "ACCEPTED";
  evidenceId?: string;
  actorStopped?: boolean;
  verifiedNoSend?: boolean;
  definitiveProviderRejection?: boolean;
  retryable?: boolean;
  retryApproved?: boolean;
}>;
export function proposeRetryGeneration(previous: RetryEvidence) {
  if (!previous || !/^[a-zA-Z0-9_-]{1,120}$/.test(previous.attemptId)
    || !Number.isSafeInteger(previous.generation) || previous.generation < 1 || previous.generation >= 2147483647) {
    return Object.freeze({ decision: "DENY" as const });
  }
  if (["UNKNOWN", "AUTHORIZED", "ACCEPTED"].includes(previous.outcome)) return Object.freeze({ decision: "RECONCILE" as const });
  if (previous.outcome === "CONFIRMED") return Object.freeze({ decision: "NEW_AUTHORIZED_INTENT" as const });
  const evidence = typeof previous.evidenceId === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(previous.evidenceId);
  const noSend = previous.outcome === "NOT_SENT" && previous.verifiedNoSend === true && previous.actorStopped === true;
  const rejected = previous.outcome === "REJECTED" && previous.definitiveProviderRejection === true && previous.retryable === true && previous.retryApproved === true;
  if (!evidence || !previous.actorStopped || !(noSend || rejected)) return Object.freeze({ decision: "DENY" as const });
  return Object.freeze({ decision: "PROPOSE_NEXT_GENERATION" as const, generation: previous.generation + 1,
    previousAttemptId: previous.attemptId, evidenceId: previous.evidenceId });
}
