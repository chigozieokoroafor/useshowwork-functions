import { normalizeReplyProfile } from "@/lib/socialMessaging/replyProfile";
import { tikTokMessagingAccess } from "@/lib/socialMessaging/tiktok";
import { whatsappMessagingAccess } from "@/lib/socialMessaging/whatsapp";
import { linkedInMessagingAccess } from "@/lib/linkedin/messagingAccess";
import type { SocialLeadStatus, SocialPlatform } from "@prisma/client";
import { db } from "@/lib/db";
import { getFacebookMessengerProfile, getInstagramMessagingProfile } from "@/lib/socialMessaging/meta";

export const SOCIAL_LEAD_STATUSES: SocialLeadStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "CUSTOMER", "NOT_A_LEAD"];
export const SOCIAL_INBOX_PLATFORMS: SocialPlatform[] = ["INSTAGRAM", "FACEBOOK", "X", "TIKTOK", "LINKEDIN", "YOUTUBE", "WHATSAPP"];

export async function getSocialInbox(calendarId: string, params: URLSearchParams) {
  const platform = params.get("platform")?.toUpperCase();
  const status = params.get("status")?.toUpperCase();
  const query = params.get("q")?.trim();
  const unread = params.get("unread") === "true";
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  if (platform && !SOCIAL_INBOX_PLATFORMS.includes(platform as SocialPlatform)) throw new Error("Choose a supported platform.");
  if (status && !SOCIAL_LEAD_STATUSES.includes(status as SocialLeadStatus)) throw new Error("Choose a valid lead status.");

  const xConnections = await db.socialConnection.findMany({ where: { calendarId, platform: "X" }, select: { id: true, connectedAt: true } });
  const where = {
    calendarId,
    AND: [{ OR: [
      { platform: { not: "X" as const } },
      ...xConnections.map(connection => ({ platform: "X" as const, socialConnectionId: connection.id,
        NOT: { providerConversationId: { startsWith: "xchat:" } },
        messages: { some: { direction: "INBOUND" as const, platformCreatedAt: { gte: connection.connectedAt } } } })),
    ] }],
    ...(platform ? { platform: platform as SocialPlatform } : {}),
    ...(status ? { leadStatus: status as SocialLeadStatus } : {}),
    ...(unread ? { unreadCount: { gt: 0 } } : {}),
    ...(query ? { OR: [
      { participantName: { contains: query, mode: "insensitive" as const } },
      { participantUsername: { contains: query, mode: "insensitive" as const } },
      { lastMessagePreview: { contains: query, mode: "insensitive" as const } },
    ] } : {}),
  };
  const [conversations, totalLeads, totalMessages, unreadResult, newMessages, settings, accounts] = await Promise.all([
    db.socialLeadConversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 100,
      include: {
        messages: { orderBy: { platformCreatedAt: "desc" }, take: 50 },
        connection: { select: { id: true, accountName: true, username: true, status: true, accessToken: true, connectedAt: true, tikTokMessagingBusinessId: true } },
      },
    }),
    db.socialLeadConversation.count({ where: { calendarId, leadStatus: { not: "NOT_A_LEAD" } } }),
    db.socialLeadMessage.count({ where: { conversation: { calendarId } } }),
    db.socialLeadConversation.aggregate({ where: { calendarId }, _sum: { unreadCount: true } }),
    db.socialLeadMessage.count({ where: { conversation: { calendarId }, direction: "INBOUND", platformCreatedAt: { gte: monthStart } } }),
    db.socialInboxSettings.findUnique({ where: { calendarId }, select: { clientAccessEnabled: true, aiAutoReplyEnabled: true, aiAutoReplyInstructions: true, aiReplyProfile: true } }),
    db.socialConnection.findMany({
      where: { calendarId, status: { not: "DISCONNECTED" } },
      select: { id: true, platform: true, platformAccountId: true, accountName: true, username: true, status: true, tokenScopes: true, accessTokenExpiresAt: true, whatsappBusinessAccountId: true, messagingWebhookSubscribedAt: true, messagingWebhookError: true, messagingLastSyncAt: true, messagingSyncError: true, tikTokMessagingBusinessId: true, tikTokMessagingScopes: true, tikTokMessagingConnectedAt: true },
      orderBy: { platform: "asc" },
    }),
  ]);
  const whatsappConversationIds = conversations.filter(conversation => conversation.platform === "WHATSAPP").map(conversation => conversation.id);
  const latestWhatsAppInbound = whatsappConversationIds.length ? await db.socialLeadMessage.groupBy({ by: ["conversationId"],
    where: { direction: "INBOUND", conversationId: { in: whatsappConversationIds } },
    _max: { platformCreatedAt: true } }) : [];
  const whatsappWindows = new Map(latestWhatsAppInbound.map(item => [item.conversationId, item._max.platformCreatedAt
    ? new Date(item._max.platformCreatedAt.getTime() + 24 * 60 * 60_000).toISOString() : null]));
  // Resolve older conversations that arrived before profile lookup was
  // implemented. Limit each request so a large inbox cannot trigger an
  // unbounded burst of Graph API calls.
  const unresolvedMetaProfiles = conversations
    .filter((conversation) => {
      const name = conversation.participantName?.trim().toLowerCase();
      const genericName = !name || ["social contact", "facebook contact", "facebook user", "instagram contact", "instagram account", "instagram user", conversation.participantPlatformId.toLowerCase()].includes(name);
      return (conversation.platform === "FACEBOOK" || conversation.platform === "INSTAGRAM")
        && (genericName || (conversation.platform === "INSTAGRAM" && !conversation.participantUsername))
        && conversation.connection?.accessToken;
    })
    .slice(0, 5);
  const resolvedProfiles = new Map<string, { name: string | null; username: string | null }>();
  await Promise.all(unresolvedMetaProfiles.map(async (conversation) => {
    const profile = conversation.platform === "INSTAGRAM"
      ? await getInstagramMessagingProfile({
          instagramScopedUserId: conversation.participantPlatformId,
          pageAccessToken: conversation.connection!.accessToken!,
        })
      : await getFacebookMessengerProfile({
          pageScopedUserId: conversation.participantPlatformId,
          pageAccessToken: conversation.connection!.accessToken!,
        });
    if (!profile?.name && !profile?.username) return;
    resolvedProfiles.set(conversation.id, profile);
    try {
      await Promise.all([
        db.socialLeadConversation.update({ where: { id: conversation.id }, data: {
          ...(profile.name ? { participantName: profile.name } : {}),
          ...(profile.username ? { participantUsername: profile.username } : {}),
        } }),
        db.calendarLead.updateMany({ where: { socialConversationId: conversation.id }, data: {
          ...(profile.name ? { name: profile.name } : {}),
          ...(profile.username ? { username: profile.username } : {}),
        } }),
      ]);
    } catch (error) {
      console.warn("Could not save social inbox profile details:", error);
    }
  }));
  return {
    summary: { leads: totalLeads, newMessages: unreadResult._sum.unreadCount ?? 0, messagesThisMonth: newMessages, allMessages: totalMessages },
    accounts: accounts.map(({ tokenScopes, tikTokMessagingScopes, ...account }) => ({
      ...account,
      ...(account.platform === "TIKTOK" && account.tikTokMessagingBusinessId ? { accountName: `TikTok Business Account ${account.tikTokMessagingBusinessId}`, username: null } : {}),
      messagingAvailable: account.platform === "WHATSAPP" ? whatsappMessagingAccess(account).available : account.platform === "TIKTOK" ? tikTokMessagingAccess({ ...account, tikTokMessagingScopes }).available : account.platform === "LINKEDIN" ? linkedInMessagingAccess({ ...account, tokenScopes }).available : account.platform === "FACEBOOK"
        ? Boolean(account.status === "CONNECTED" && tokenScopes?.split(/[\s,]+/).includes("pages_messaging") && account.messagingWebhookSubscribedAt && !account.messagingWebhookError)
        : account.platform === "INSTAGRAM"
          ? Boolean(account.status === "CONNECTED" && tokenScopes?.split(/[\s,]+/).includes("instagram_manage_messages") && account.messagingWebhookSubscribedAt && (!account.messagingWebhookError || account.messagingWebhookError.startsWith("The Facebook Page subscription succeeded.")))
          : account.platform === "X" && account.status === "CONNECTED" && ["dm.read", "dm.write", "tweet.read", "users.read"].every(scope => tokenScopes?.split(/[\s,]+/).includes(scope)),
      messagingNote: account.platform === "WHATSAPP" ? whatsappMessagingAccess(account).reason : account.platform === "LINKEDIN" ? linkedInMessagingAccess({ ...account, tokenScopes }).reason : account.platform === "FACEBOOK" || account.platform === "INSTAGRAM"
        ? account.messagingWebhookError && !(account.platform === "INSTAGRAM" && account.messagingWebhookError.startsWith("The Facebook Page subscription succeeded."))
          ? account.messagingWebhookError
          : !(account.platform === "FACEBOOK" ? tokenScopes?.includes("pages_messaging") : tokenScopes?.includes("instagram_manage_messages"))
            ? "Reconnect and authorize messaging"
            : !account.messagingWebhookSubscribedAt
              ? "Reconnect this account to subscribe its messaging webhook"
              : account.platform === "INSTAGRAM"
                ? "Page subscription succeeded. Meta must also enable this app’s Instagram `messages` webhook field for inbound DMs."
              : "Messaging enabled"
        : account.platform === "TIKTOK"
          ? tikTokMessagingAccess({ ...account, tikTokMessagingScopes }).reason
          : account.platform === "X"
            ? account.messagingSyncError || (["dm.read", "dm.write", "tweet.read", "users.read"].every(scope => tokenScopes?.split(/[\s,]+/).includes(scope)) ? (account.messagingLastSyncAt ? "X messages last synced " + account.messagingLastSyncAt.toISOString() + ". Group chats are excluded." : "Connected, but X messages have not synced yet. Use Sync X messages to import them.") : "Reconnect X to authorize direct messages")
            : "Messaging is not supported for this channel",
    })),
    settings: { ...(settings ?? { clientAccessEnabled: true, aiAutoReplyEnabled: false, aiAutoReplyInstructions: null }), aiReplyProfile: normalizeReplyProfile(settings?.aiReplyProfile) },
    conversations: conversations.map((conversation) => {
      const cutoff = conversation.platform === "X" ? conversation.connection?.connectedAt?.getTime() ?? Infinity : -Infinity;
      const visibleMessages = conversation.messages.filter(message => message.platformCreatedAt.getTime() >= cutoff);
      const previewVisible = conversation.platform !== "X" || (conversation.lastMessageAt?.getTime() ?? 0) >= cutoff;
      const resolvedProfile = resolvedProfiles.get(conversation.id);
      const participantUsername = resolvedProfile?.username || conversation.participantUsername;
      const rawName = resolvedProfile?.name || conversation.participantName;
      const genericNames = ["social contact", "facebook contact", "facebook user", "instagram contact", "instagram account", "instagram user", conversation.participantPlatformId.toLowerCase()];
      const participantName = rawName && !genericNames.includes(rawName.trim().toLowerCase()) ? rawName : null;
      return ({
      id: conversation.id,
      ...(conversation.platform === "X" && conversation.socialConnectionId && conversation.providerConversationId.startsWith("xchat:") ? { encrypted: { connectionId: conversation.socialConnectionId, conversationId: conversation.providerConversationId.slice(6) } } : {}),
      platform: conversation.platform,
      providerConversationId: conversation.providerConversationId,
      participantPlatformId: conversation.participantPlatformId,
      participantUsername,
      ...(conversation.platform === "WHATSAPP" ? { replyWindowExpiresAt: whatsappWindows.get(conversation.id) ?? null } : {}),
      leadStatus: conversation.leadStatus,
      unreadCount: previewVisible ? conversation.unreadCount : 0,
      lastMessagePreview: previewVisible ? conversation.lastMessagePreview : null,
      lastMessageAt: previewVisible ? conversation.lastMessageAt?.toISOString() ?? null : null,
      participantName,
      connection: conversation.connection ? {
        id: conversation.connection.id,
        accountName: conversation.platform === "TIKTOK" && conversation.connection.tikTokMessagingBusinessId ? `TikTok Business Account ${conversation.connection.tikTokMessagingBusinessId}` : conversation.connection.accountName,
        username: conversation.platform === "TIKTOK" && conversation.connection.tikTokMessagingBusinessId ? null : conversation.connection.username,
        status: conversation.connection.status,
      } : null,
      messages: [...visibleMessages].reverse().map((message) => ({
        id: message.id,
        direction: message.direction,
        status: message.status,
        text: message.text,
        platformCreatedAt: message.platformCreatedAt.toISOString(),
        sentByCreatorId: message.sentByCreatorId,
        isAiGenerated: message.isAiGenerated,
        autoReplyHandoffReason: message.autoReplyHandoffReason,
        sendError: message.sendError,
      })),
    }); }),
  };
}
