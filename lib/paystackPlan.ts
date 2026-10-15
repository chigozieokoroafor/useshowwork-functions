/** Transaction verification can expose the plan in plan_object rather than plan. */
export function extractPaystackPlanCode(
  data:
    | {
        plan?: unknown;
        plan_object?: { plan_code?: unknown } | null;
      }
    | null
    | undefined,
): string | null {
  const direct =
    typeof data?.plan === "string"
      ? data.plan
      : data?.plan && typeof data.plan === "object" && "plan_code" in data.plan
        ? data.plan.plan_code
        : null;
  const code = direct ?? data?.plan_object?.plan_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}
