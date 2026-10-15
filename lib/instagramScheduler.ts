import { runScheduledPublishing } from "@/lib/publishing/scheduler";
export const runScheduledInstagramPublishing = () => runScheduledPublishing(["INSTAGRAM"]);
