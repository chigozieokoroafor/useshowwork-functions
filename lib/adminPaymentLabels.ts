export function paymentCategory(
  type: string,
): "CONTENT_WORKSPACE" | "PORTFOLIO" | "PROJECT_DELIVERY" | "BILLING" {
  if (type.startsWith("CALENDAR_") || type.startsWith("CONTENT_WORKSPACE_"))
    return "CONTENT_WORKSPACE";
  if (type.startsWith("PORTFOLIO_")) return "PORTFOLIO";
  if (type === "PROJECT_ONE_TIME") return "PROJECT_DELIVERY";
  return "BILLING";
}
export function paymentAction(type: string) {
  const actions: Record<string, string> = {
    PROJECT_ONE_TIME: "Project payment received",
    PORTFOLIO_ONE_TIME: "Portfolio one-time payment received",
    SUBSCRIPTION_INITIAL: "Project Delivery subscription started",
    SUBSCRIPTION_RENEWAL: "Project Delivery subscription renewed",
    PORTFOLIO_SUBSCRIPTION_INITIAL: "Portfolio subscription started",
    PORTFOLIO_SUBSCRIPTION_RENEWAL: "Portfolio subscription renewed",
    CALENDAR_SUBSCRIPTION_INITIAL: "Content Workspace subscription started",
    CALENDAR_SUBSCRIPTION_RENEWAL: "Content Workspace subscription renewed",
    CONTENT_WORKSPACE_SUBSCRIPTION_INITIAL:
      "Content Workspace subscription started",
    CONTENT_WORKSPACE_SUBSCRIPTION_RENEWAL:
      "Content Workspace subscription renewed",
    AI_ASSISTANT_SUBSCRIPTION_INITIAL: "AI subscription started",
    AI_ASSISTANT_SUBSCRIPTION_RENEWAL: "AI subscription renewed",
  };
  return actions[type] ?? "Payment received";
}
export function paymentProductDescription(type: string) {
  if (type.startsWith("CALENDAR_") || type.startsWith("CONTENT_WORKSPACE_"))
    return "Content Workspace";
  if (type.startsWith("PORTFOLIO_")) return "a portfolio";
  if (type.startsWith("AI_ASSISTANT_")) return "AI Assistant";
  if (type === "PROJECT_ONE_TIME" || type.startsWith("SUBSCRIPTION_"))
    return "Project Delivery";
  return "Showwork";
}
