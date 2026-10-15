/** Enqueue a newly received message without waiting for AI/provider calls.
 * The minute cron remains the recovery path if this best-effort dispatch fails. */
export async function dispatchSocialInboxAutoReply(messageId: string) {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) return false;
  try {
    const response = await fetch(`${siteUrl}/.netlify/functions/social-inbox-auto-reply-background`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`Background auto-reply dispatch returned ${response.status}.`);
    return true;
  } catch (error) {
    console.error("Immediate social inbox auto-reply dispatch failed; scheduled recovery will retry:", error);
    return false;
  }
}
