import { runScheduledPublishing } from "@/lib/publishing/scheduler";
export const runScheduledTikTokPublishing = () => runScheduledPublishing(["TIKTOK"]);
