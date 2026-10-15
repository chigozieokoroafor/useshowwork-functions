export const ADMIN_TOOLS = {
  all: "All tools",
  delivery: "Project Delivery",
  projects: "Project Management",
  portfolio: "Portfolio",
  workspace: "Content Workspace",
  ai: "AI Assistant",
  community: "Community",
  unattributed: "Unattributed payments",
} as const;
export type AdminTool = keyof typeof ADMIN_TOOLS;
