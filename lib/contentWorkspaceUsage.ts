import { lockWorkspaceUploadReservation, lockWorkspaceUploadUsage } from "@/lib/workspaceUploadLocks";
import { complimentaryAccessSelect, workspaceComplimentaryPlan, type ComplimentaryAccount } from "@/lib/complimentaryAccess";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  CONTENT_WORKSPACE_PLANS,
  ENGAGE_TRIAL_AI_REPLY_LIMIT,
  WORKSPACE_TRIAL_AI_CREDITS_LIMIT,
  getTrialAiCreditCost,
  planIncludesWorkspaceFeature,
  type ContentWorkspaceFeature,
  type ContentWorkspacePlan,
  type ContentWorkspaceBillingCycle,
} from "@/lib/contentWorkspaceEntitlements";
import type {
  CalendarBillingStatus,
  ContentWorkspaceStorageReservationStatus,
} from "@prisma/client";

/** Retry the entire transaction so every attempt reads fresh quota counters. */
async function retryStorageTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt >= maxAttempts - 1
      ) {
        throw error;
      }
      // Backoff and jitter prevent simultaneous uploads retrying in lockstep.
      const delayMs = Math.min(100 * 2 ** attempt, 1000) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export interface ContentWorkspaceAccount extends ComplimentaryAccount {
  id: string;
  contentWorkspacePlan: ContentWorkspacePlan | null;
  contentWorkspaceBillingStatus: CalendarBillingStatus;
  contentWorkspaceBillingCycle: ContentWorkspaceBillingCycle | null;
  contentWorkspaceTrialUsedAt?: Date | null;
  contentWorkspaceTrialEndsAt: Date | null;
  isComped: boolean;
  compedUntil: Date | null;
}

export interface ContentWorkspaceUsage {
  plan: ContentWorkspacePlan | null;
  billingStatus: CalendarBillingStatus;
  hasAccess: boolean;

  activeWorkspaces: number;
  workspaceLimit: number;

  collaborators: number;
  collaboratorLimit: number;

  storageBytes: number;
  storageReservedBytes: number;
  storageLimitBytes: number;
  storageRemainingBytes: number;

  aiGenerationsUsed: number;
  aiGenerationLimit: number;
  aiGenerationsRemaining: number;

  aiRegenerationsUsed: number;
  aiRegenerationLimit: number;
  aiRegenerationsRemaining: number;

  cycleStart: Date | null;
  trialAiCreditsUsed?: number;
  trialAiCreditsLimit?: number;
  trialAiCreditsRemaining?: number;
  isTrial?: boolean;
}

import {isContentWorkspaceTrialActive,isComplimentaryAccessActive,canAccessContentWorkspace,getContentWorkspacePlan,canUseContentWorkspaceFeature,currentAiCycleStart,validateCanonicalWorkspaceUsage} from "./contentWorkspacePolicy";
export {isContentWorkspaceTrialActive,isComplimentaryAccessActive,canAccessContentWorkspace,getContentWorkspacePlan,canUseContentWorkspaceFeature,currentAiCycleStart,validateCanonicalWorkspaceUsage} from "./contentWorkspacePolicy";

/**
 * Counts the creator's currently owned Marketing Workspaces.
 */
export async function getActiveWorkspaceCount(
  creatorId: string
): Promise<number> {
  return db.socialCalendar.count({
    where: {
      managerId: creatorId,
    },
  });
}

/**
 * Counts current collaborators across the creator's owned Marketing Workspaces.
 */
export async function getCollaboratorCount(
  creatorId: string
): Promise<number> {
  return db.calendarCollaborator.count({
    where: {
      calendar: {
        managerId: creatorId,
      },
    },
  });
}

/** Monthly AI allowances also reset for annual subscriptions; storage never resets. */
/**
 * Ensures the creator has a usage row.
 */
export async function getOrCreateContentWorkspaceUsage(creatorId: string, engageTrial = false) {
  const usage = await db.contentWorkspaceUsage.upsert({
    where: {
      creatorId,
    },
    create: {
      creatorId,
      cycleStart: new Date(),
      storageBytes: 0,
      storageReservedBytes: 0,
      aiGenerationsUsed: 0,
      aiRegenerationsUsed: 0,
    },
    update: {},
  });
  if (engageTrial) return usage;
  const cycleStart = currentAiCycleStart(usage.cycleStart);
  if (cycleStart.getTime() !== usage.cycleStart.getTime()) {
    // Compare-and-swap avoids resetting a quota twice during concurrent requests.
    await db.contentWorkspaceUsage.updateMany({
      where: { creatorId, cycleStart: usage.cycleStart },
      data: { cycleStart, aiGenerationsUsed: 0, aiRegenerationsUsed: 0 },
    });
    return db.contentWorkspaceUsage.findUniqueOrThrow({ where: { creatorId } });
  }
  return usage;
}

/**
 * Returns the complete current entitlement/usage picture for a creator.
 */
export async function getContentWorkspaceUsage(
  account: ContentWorkspaceAccount
): Promise<ContentWorkspaceUsage> {
  const plan = getContentWorkspacePlan(account);

  if (!plan) {
    return {
      plan: null,
      billingStatus: account.contentWorkspaceBillingStatus,
      hasAccess: false,

      activeWorkspaces: await getActiveWorkspaceCount(account.id),
      workspaceLimit: 0,

      collaborators: await getCollaboratorCount(account.id),
      collaboratorLimit: 0,

      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes: 0,
      storageRemainingBytes: 0,

      aiGenerationsUsed: 0,
      aiGenerationLimit: 0,
      aiGenerationsRemaining: 0,

      aiRegenerationsUsed: 0,
      aiRegenerationLimit: 0,
      aiRegenerationsRemaining: 0,

      cycleStart: null,
    };
  }

  const entitlements = CONTENT_WORKSPACE_PLANS[plan];
  const isTrial = (isContentWorkspaceTrialActive(account) || account.contentWorkspaceBillingStatus === "TRIAL") && !isComplimentaryAccessActive(account);
  const engageTrial = plan === "ENGAGE" && account.contentWorkspaceBillingStatus === "TRIAL";
  const aiGenerationLimit = isTrial
    ? (engageTrial ? ENGAGE_TRIAL_AI_REPLY_LIMIT : WORKSPACE_TRIAL_AI_CREDITS_LIMIT)
    : entitlements.aiGenerations;

  const [workspaceCount, collaboratorCount, usage] = await Promise.all([
    getActiveWorkspaceCount(account.id),
    getCollaboratorCount(account.id),
    getOrCreateContentWorkspaceUsage(account.id, engageTrial),
  ]);

  const storageBytes = Number(usage.storageBytes);
  const storageReservedBytes = Number(usage.storageReservedBytes);
  const storageLimitBytes = entitlements.storageBytes;

  return {
    plan,
    billingStatus: account.contentWorkspaceBillingStatus,
    hasAccess: canAccessContentWorkspace(account),

    activeWorkspaces: workspaceCount,
    workspaceLimit: entitlements.activeWorkspaces,

    collaborators: collaboratorCount,
    collaboratorLimit: entitlements.collaborators,

    storageBytes,
    storageReservedBytes,
    storageLimitBytes,

    storageRemainingBytes: Math.max(
      0,
      storageLimitBytes - storageBytes - storageReservedBytes
    ),

    aiGenerationsUsed: isTrial && !engageTrial ? usage.trialAiCreditsUsed : usage.aiGenerationsUsed,
    aiGenerationLimit,
    aiGenerationsRemaining: Math.max(
      0,
      aiGenerationLimit - (isTrial && !engageTrial ? usage.trialAiCreditsUsed : usage.aiGenerationsUsed)
    ),
    trialAiCreditsUsed: usage.trialAiCreditsUsed,
    trialAiCreditsLimit: WORKSPACE_TRIAL_AI_CREDITS_LIMIT,
    trialAiCreditsRemaining: Math.max(0, WORKSPACE_TRIAL_AI_CREDITS_LIMIT - usage.trialAiCreditsUsed),
    isTrial,

    aiRegenerationsUsed: usage.aiRegenerationsUsed,
    aiRegenerationLimit: entitlements.aiRegenerations,
    aiRegenerationsRemaining: Math.max(
      0,
      Math.min(entitlements.aiRegenerations - usage.aiRegenerationsUsed, aiGenerationLimit - usage.aiGenerationsUsed)
    ),

    cycleStart: usage.cycleStart,
  };
}

/**
 * Checks whether another Marketing Workspace can be created.
 */
/**
 * Checks whether another Marketing Workspace can be created.
 *
 * A creator who has never used their Marketing Workspace trial may
 * create their first workspace. The creation route starts the
 * 3-day trial immediately after the workspace is created.
 */
export async function canCreateContentWorkspace(
  account: ContentWorkspaceAccount
): Promise<{
  allowed: boolean;
  reason?: string;
  usage: ContentWorkspaceUsage;
}> {
  const usage = await getContentWorkspaceUsage(account);

 const hasUnusedTrial =
  !!usage.plan &&
  account.contentWorkspaceTrialUsedAt === null;

  if (!usage.hasAccess && !hasUnusedTrial) {
    return {
      allowed: false,
      reason:
        "Your Marketing Workspace subscription or trial is not active.",
      usage,
    };
  }

  if (
    usage.activeWorkspaces >= usage.workspaceLimit && !hasUnusedTrial
  ) {
    return {
      allowed: false,
      reason: `Your ${usage.plan} plan allows up to ${
        usage.workspaceLimit
      } active Marketing Workspace${
        usage.workspaceLimit === 1 ? "" : "s"
      }. Upgrade to increase your allowance. Existing workspaces are preserved.`,
      usage,
    };
  }

  return {
    allowed: true,
    usage,
  };
}
/**
 * Checks whether another collaborator can be added.
 */
export async function canAddContentWorkspaceCollaborator(
  account: ContentWorkspaceAccount
): Promise<{
  allowed: boolean;
  reason?: string;
  usage: ContentWorkspaceUsage;
}> {
  const usage = await getContentWorkspaceUsage(account);

  if (!usage.hasAccess) {
    return {
      allowed: false,
      reason: "Your Marketing Workspace subscription or trial is not active.",
      usage,
    };
  }

  if (usage.collaborators >= usage.collaboratorLimit) {
    return {
      allowed: false,
      reason: `Your ${usage.plan} plan allows up to ${usage.collaboratorLimit} collaborators. Upgrade to increase your allowance.`,
      usage,
    };
  }

  return {
    allowed: true,
    usage,
  };
}

function formatStorageBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }

  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }

  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(2)} KB`;
  }

  return `${bytes} bytes`;
}

/**
 * Creates a storage reservation for a specific upload.
 *
 * The reservation is tied to the creator, calendar and R2 file key.
 * This prevents one upload from accidentally finalizing or releasing
 * another upload's reservation.
 */
export async function reserveContentWorkspaceStorage(
  creatorId: string,
  calendarId: string,
  fileKey: string,
  bytes: number,
  receiptId?: string,
): Promise<{
  allowed: boolean;
  reason?: string;
  reservationId?: string;
  storageBytes: number;
  storageReservedBytes: number;
  storageLimitBytes: number;
  storageRemainingBytes: number;
}> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return {
      allowed: false,
      reason: "A valid file size is required.",
      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes: 0,
      storageRemainingBytes: 0,
    };
  }

  if (!fileKey || !calendarId) {
    return {
      allowed: false,
      reason: "A valid upload destination is required.",
      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes: 0,
      storageRemainingBytes: 0,
    };
  }

  const [creator, calendar] = await Promise.all([
    db.creator.findUnique({
      where: { id: creatorId },
      select: {
        contentWorkspacePlan: true,
        contentWorkspaceBillingStatus: true,
        contentWorkspaceTrialEndsAt: true,
        ...complimentaryAccessSelect, isComped: true, compedUntil: true,
      },
    }),
    db.socialCalendar.findUnique({ where: { id: calendarId }, select: { managerId: true } }),
  ]);

  if (!creator) {
    return {
      allowed: false,
      reason: "Creator not found.",
      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes: 0,
      storageRemainingBytes: 0,
    };
  }

  const plan = getContentWorkspacePlan(creator);

  if (!plan || !canAccessContentWorkspace(creator)) {
    return {
      allowed: false,
      reason: "Your Marketing Workspace subscription or trial is not active.",
      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes: 0,
      storageRemainingBytes: 0,
    };
  }

  const storageLimitBytes = CONTENT_WORKSPACE_PLANS[plan].storageBytes;

  /*
   * Ensure the calendar belongs to this creator.
   * This prevents a caller from creating a reservation against
   * an unrelated workspace.
   */
  if (!calendar || calendar.managerId !== creatorId) {
    return {
      allowed: false,
      reason: "Marketing Workspace not found.",
      storageBytes: 0,
      storageReservedBytes: 0,
      storageLimitBytes,
      storageRemainingBytes: 0,
    };
  }

  const result = await retryStorageTransaction(() => db.$transaction(
    async (tx) => {
    // Initialize and read storage in one operation, inside the retryable transaction.
    // Uploads do not need to reset or fetch unrelated monthly AI allowances.
    const current = await tx.contentWorkspaceUsage.upsert({
      where: { creatorId },
      create: { creatorId, cycleStart: new Date(), storageBytes: 0, storageReservedBytes: 0,
        aiGenerationsUsed: 0, aiRegenerationsUsed: 0 },
      update: {},
      select: {
        storageBytes: true,
        storageReservedBytes: true,
      },
    });

    if (!current) {
      return {
        allowed: false as const,
        storageBytes: 0,
        storageReservedBytes: 0,
      };
    }

    const storageBytes = Number(current.storageBytes);
    const storageReservedBytes = Number(current.storageReservedBytes);
    const remaining =
      storageLimitBytes - storageBytes - storageReservedBytes;

    if (bytes > remaining) {
      return {
        allowed: false as const,
        storageBytes,
        storageReservedBytes,
      };
    }

    await tx.contentWorkspaceUsage.update({
      where: { creatorId },
      data: {
        storageReservedBytes: {
          increment: BigInt(bytes),
        },
      },
    });

    const reservation =
      await tx.contentWorkspaceStorageReservation.create({
        data: {
          ...(receiptId ? { id: receiptId } : {}),
          creatorId,
          calendarId,
          fileKey,
          bytes: BigInt(bytes),
          status: "PENDING",
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
        },
        select: {
          id: true,
        },
      });

    return {
      allowed: true as const,
      reservationId: reservation.id,
      storageBytes,
      storageReservedBytes: storageReservedBytes + bytes,
    };
    },
    {
      maxWait: 15000,
      timeout: 15000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }
  ));

  if (!result.allowed) {
    return {
      allowed: false,
      reason: `This upload exceeds your available Marketing Workspace storage. You have ${formatStorageBytes(
        Math.max(
          0,
          storageLimitBytes -
            result.storageBytes -
            result.storageReservedBytes
        )
      )} remaining.`,
      storageBytes: result.storageBytes,
      storageReservedBytes: result.storageReservedBytes,
      storageLimitBytes,
      storageRemainingBytes: Math.max(
        0,
        storageLimitBytes -
          result.storageBytes -
          result.storageReservedBytes
      ),
    };
  }

  return {
    allowed: true,
    reservationId: result.reservationId,
    storageBytes: result.storageBytes,
    storageReservedBytes: result.storageReservedBytes,
    storageLimitBytes,
    storageRemainingBytes: Math.max(
      0,
      storageLimitBytes -
        result.storageBytes -
        result.storageReservedBytes
    ),
  };
}

/**
 * Finalizes one specific upload reservation.
 *
 * This is idempotent: a reservation already marked COMPLETED
 * cannot be counted again.
 */
export async function finalizeContentWorkspaceStorageReservation(
  reservationId: string,
  creatorId: string,
  calendarId: string,
  fileKey: string
): Promise<{
  success: boolean;
  bytes: number;
  alreadyFinalized?: boolean;
  error?: string;
}> {
  if (!reservationId || !creatorId || !calendarId || !fileKey) {
    return {
      success: false,
      bytes: 0,
      error: "Invalid storage reservation.",
    };
  }

  return db.$transaction(async (tx) => {
    const reservation =
      await tx.contentWorkspaceStorageReservation.findUnique({
        where: { id: reservationId },
      });

    if (!reservation) {
      return {
        success: false,
        bytes: 0,
        error: "Storage reservation not found.",
      };
    }

    if (
      reservation.creatorId !== creatorId ||
      reservation.calendarId !== calendarId ||
      reservation.fileKey !== fileKey
    ) {
      return {
        success: false,
        bytes: 0,
        error: "Storage reservation does not match this upload.",
      };
    }

    if (
      reservation.status ===
      ("COMPLETED" as ContentWorkspaceStorageReservationStatus)
    ) {
      return {
        success: true,
        bytes: Number(reservation.bytes),
        alreadyFinalized: true,
      };
    }

    if (
      reservation.status !==
      ("PENDING" as ContentWorkspaceStorageReservationStatus)
    ) {
      return {
        success: false,
        bytes: 0,
        error: "This storage reservation is no longer active.",
      };
    }

    const bytes = Number(reservation.bytes);

    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      return {
        success: false,
        bytes: 0,
        error: "Invalid reserved file size.",
      };
    }

    const usage = await tx.contentWorkspaceUsage.findUnique({
      where: { creatorId },
      select: {
        storageReservedBytes: true,
      },
    });

    if (!usage || Number(usage.storageReservedBytes) < bytes) {
      return {
        success: false,
        bytes: 0,
        error: "Storage reservation accounting is inconsistent.",
      };
    }

    await tx.contentWorkspaceUsage.update({
      where: { creatorId },
      data: {
        storageReservedBytes: {
          decrement: BigInt(bytes),
        },
        storageBytes: {
          increment: BigInt(bytes),
        },
      },
    });

    await tx.contentWorkspaceStorageReservation.update({
      where: { id: reservationId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    return {
      success: true,
      bytes,
    };
  });
}

/**
 * Releases one specific pending upload reservation.
 *
 * This is idempotent: COMPLETED and RELEASED reservations are not
 * deducted a second time.
 */
export async function releaseContentWorkspaceStorageReservation(
  reservationId: string,
  creatorId: string,
  calendarId: string,
  fileKey: string
): Promise<{
  success: boolean;
  bytes: number;
  alreadyReleased?: boolean;
  error?: string;
}> {
  if (!reservationId || !creatorId || !calendarId || !fileKey) {
    return {
      success: false,
      bytes: 0,
      error: "Invalid storage reservation.",
    };
  }

  return db.$transaction(async (tx) => {
    const reservation = await lockWorkspaceUploadReservation(tx, reservationId);

    if (!reservation) {
      return {
        success: false,
        bytes: 0,
        error: "Storage reservation not found.",
      };
    }

    if (
      reservation.creatorId !== creatorId ||
      reservation.calendarId !== calendarId ||
      reservation.fileKey !== fileKey
    ) {
      return {
        success: false,
        bytes: 0,
        error: "Storage reservation does not match this upload.",
      };
    }

    if (
      reservation.status ===
      ("RELEASED" as ContentWorkspaceStorageReservationStatus)
    ) {
      return {
        success: true,
        bytes: Number(reservation.bytes),
        alreadyReleased: true,
      };
    }

    if (
      reservation.status !==
      ("PENDING" as ContentWorkspaceStorageReservationStatus)
    ) {
      return {
        success: false,
        bytes: 0,
        error: "This storage reservation is no longer pending.",
      };
    }

    const bytes = Number(reservation.bytes);

    await lockWorkspaceUploadUsage(tx, creatorId);
    const usage = await tx.contentWorkspaceUsage.findUnique({
      where: { creatorId },
      select: {
        storageReservedBytes: true,
      },
    });

    if (!usage) {
      return {
        success: false,
        bytes: 0,
        error: "Marketing Workspace usage record not found.",
      };
    }

    const reservedBytes = Number(usage.storageReservedBytes);
    const releaseBytes = Math.min(reservedBytes, bytes);

    if (releaseBytes > 0) {
      await tx.contentWorkspaceUsage.update({
        where: { creatorId },
        data: {
          storageReservedBytes: {
            decrement: BigInt(releaseBytes),
          },
        },
      });
    }

    await tx.contentWorkspaceStorageReservation.update({
      where: { id: reservationId },
      data: {
        status: "RELEASED",
        releasedAt: new Date(),
      },
    });

    return {
      success: true,
      bytes: releaseBytes,
    };
  });
}

/**
 * Removes confirmed storage usage after a Marketing Workspace file
 * is deleted.
 */
export async function releaseContentWorkspaceStorage(
  creatorId: string,
  bytes: number
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return;
  }

  await db.$transaction(async (tx) => {
    await lockWorkspaceUploadUsage(tx, creatorId);
    const usage = await tx.contentWorkspaceUsage.findUnique({
      where: { creatorId },
      select: {
        storageBytes: true,
      },
    });

    if (!usage) {
      return;
    }

    const currentBytes = Number(usage.storageBytes);
    const releaseBytes = Math.min(currentBytes, bytes);

    if (releaseBytes <= 0) {
      return;
    }

    await tx.contentWorkspaceUsage.update({
      where: { creatorId },
      data: {
        storageBytes: {
          decrement: BigInt(releaseBytes),
        },
      },
    });
  });
}

/**
 * Atomically consumes one AI generation.
 */
export async function consumeAiGeneration(
  creatorId: string,
  creditCost = 1
): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  engageTrial?: boolean;
  isTrial?: boolean;
}> {
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: {
      contentWorkspacePlan: true,
      contentWorkspaceBillingStatus: true,
      contentWorkspaceTrialEndsAt: true,
      ...complimentaryAccessSelect,
      isComped: true,
      compedUntil: true,
    },
  });

  if (!creator) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      remaining: 0,
    };
  }

  const plan = getContentWorkspacePlan(creator);

  if (!plan || !canAccessContentWorkspace(creator)) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      remaining: 0,
    };
  }

  const isTrial = (isContentWorkspaceTrialActive(creator) || creator.contentWorkspaceBillingStatus === "TRIAL") && !isComplimentaryAccessActive(creator);
  const engageTrial = plan === "ENGAGE" && creator.contentWorkspaceBillingStatus === "TRIAL";
  const cost = Math.max(1, creditCost);

  // 10-credit limit for Showwork's 3-day free trial.
  // A single draft costs 1 credit, and a short content plan costs 3.
  if (isTrial && !engageTrial) {
    const limit = WORKSPACE_TRIAL_AI_CREDITS_LIMIT;
    const usage = await getOrCreateContentWorkspaceUsage(creatorId, false);

    if (usage.trialAiCreditsUsed + cost > limit) {
      return {
        allowed: false,
        isTrial: true,
        used: usage.trialAiCreditsUsed,
        limit,
        remaining: Math.max(0, limit - usage.trialAiCreditsUsed),
      };
    }

    const consumed = await db.contentWorkspaceUsage.updateMany({
      where: {
        creatorId,
        trialAiCreditsUsed: { lte: limit - cost },
      },
      data: {
        trialAiCreditsUsed: { increment: cost },
        aiGenerationsUsed: { increment: cost },
      },
    });

    const updated = await db.contentWorkspaceUsage.findUniqueOrThrow({ where: { creatorId } });
    return {
      allowed: consumed.count === 1,
      isTrial: true,
      used: updated.trialAiCreditsUsed,
      limit,
      remaining: Math.max(0, limit - updated.trialAiCreditsUsed),
    };
  }

  const limit = engageTrial ? ENGAGE_TRIAL_AI_REPLY_LIMIT : CONTENT_WORKSPACE_PLANS[plan].aiGenerations;
  // Both inbox paths charge the same counter. A trial never rolls over mid-trial.
  const usage = await getOrCreateContentWorkspaceUsage(creatorId, engageTrial);

  if (usage.aiGenerationsUsed + cost > limit) {
    return {
      allowed: false,
      engageTrial,
      isTrial: false,
      used: usage.aiGenerationsUsed,
      limit,
      remaining: Math.max(0, limit - usage.aiGenerationsUsed),
    };
  }

  const consumed = await db.contentWorkspaceUsage.updateMany({
    where: { creatorId, cycleStart: usage.cycleStart, aiGenerationsUsed: { lte: limit - cost } },
    data: { aiGenerationsUsed: { increment: cost } },
  });
  const updated = await db.contentWorkspaceUsage.findUniqueOrThrow({ where: { creatorId } });
  return {
    allowed: consumed.count === 1,
    engageTrial,
    isTrial: false,
    used: updated.aiGenerationsUsed,
    limit,
    remaining: Math.max(0, limit - updated.aiGenerationsUsed),
  };
}

export async function refundAiGeneration(creatorId: string, creditCost = 1) {
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: {
      contentWorkspaceBillingStatus: true,
      contentWorkspaceTrialEndsAt: true,
      ...complimentaryAccessSelect,
      isComped: true,
      compedUntil: true,
    },
  });
  if (!creator) return;
  const cost = Math.max(1, creditCost);
  const isTrial = (isContentWorkspaceTrialActive(creator) || creator.contentWorkspaceBillingStatus === "TRIAL") && !isComplimentaryAccessActive(creator);
  if (isTrial) {
    await db.contentWorkspaceUsage.updateMany({
      where: { creatorId, trialAiCreditsUsed: { gte: cost } },
      data: {
        trialAiCreditsUsed: { decrement: cost },
        aiGenerationsUsed: { decrement: cost },
      },
    });
  } else {
    await db.contentWorkspaceUsage.updateMany({
      where: { creatorId, aiGenerationsUsed: { gte: cost } },
      data: { aiGenerationsUsed: { decrement: cost } },
    });
  }
}

export async function resetPaidContentWorkspaceAllowance(creatorId: string) {
  await db.contentWorkspaceUsage.upsert({
    where: { creatorId },
    create: {
      creatorId,
      cycleStart: new Date(),
      storageBytes: 0,
      storageReservedBytes: 0,
      aiGenerationsUsed: 0,
      aiRegenerationsUsed: 0,
      trialAiCreditsUsed: WORKSPACE_TRIAL_AI_CREDITS_LIMIT,
    },
    update: {
      cycleStart: new Date(),
      aiGenerationsUsed: 0,
      aiRegenerationsUsed: 0,
    },
  });
}

/** Inbox drafting, automatic replies and performance analysis share the included AI allowance. */
export async function consumeCalendarAiGeneration(calendarId: string) {
  const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId }, select: { managerId: true } });
  if (!calendar) return { allowed: false, used: 0, limit: 0, remaining: 0, engageTrial: false };
  return consumeAiGeneration(calendar.managerId);
}

/**
 * Atomically consumes one AI regeneration.
 */
export async function consumeAiRegeneration(
  creatorId: string
): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  cycleStart?: Date;
}> {
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: {
  contentWorkspacePlan: true,
  contentWorkspaceBillingStatus: true,
  contentWorkspaceTrialEndsAt: true,
  ...complimentaryAccessSelect, isComped: true,
  compedUntil: true,
},
  });

  if (!creator) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      remaining: 0,
    };
  }

  const plan = getContentWorkspacePlan(creator);

  if (!plan || !canAccessContentWorkspace(creator)) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      remaining: 0,
    };
  }

  const limit = CONTENT_WORKSPACE_PLANS[plan].aiRegenerations;
  const usage = await getOrCreateContentWorkspaceUsage(creatorId, plan === "ENGAGE" && creator.contentWorkspaceBillingStatus === "TRIAL");

  if (usage.aiRegenerationsUsed >= limit || usage.aiGenerationsUsed >= limit) {
    return {
      allowed: false,
      used: usage.aiGenerationsUsed,
      limit,
      remaining: 0,
    };
  }

  const consumed = await db.contentWorkspaceUsage.updateMany({
    where: { creatorId, cycleStart: usage.cycleStart, aiRegenerationsUsed: { lt: limit }, aiGenerationsUsed: { lt: limit } },
    data: { aiRegenerationsUsed: { increment: 1 }, aiGenerationsUsed: { increment: 1 } },
  });
  const updated = await db.contentWorkspaceUsage.findUniqueOrThrow({ where: { creatorId } });
  return {
    allowed: consumed.count === 1,
    used: updated.aiGenerationsUsed, limit, cycleStart: usage.cycleStart,
    remaining: Math.max(0, limit - updated.aiGenerationsUsed),
  };
}
/**
 * Releases expired pending Marketing Workspace storage reservations.
 *
 * This is intended to run from a scheduled maintenance job.
 * Each reservation is handled transactionally so its reserved bytes
 * are released exactly once.
 */
export async function cleanupExpiredContentWorkspaceStorageReservations(): Promise<{
  processed: number;
  released: number;
  failed: number;
  releasedBytes: number;
}> {
  const now = new Date();

  const reservations =
    await db.contentWorkspaceStorageReservation.findMany({
      where: {
        status: "PENDING",
        expiresAt: {
          lte: now,
        },
      },
      select: {
        id: true,
        creatorId: true,
        bytes: true,
      },
      orderBy: {
        expiresAt: "asc",
      },
      take: 100,
    });

  let released = 0;
  let failed = 0;
  let releasedBytes = 0;

  for (const reservation of reservations) {
    try {
      const result = await db.$transaction(async (tx) => {
        const current = await lockWorkspaceUploadReservation(tx, reservation.id);

        if (
          !current ||
          current.status !== "PENDING" ||
          current.expiresAt > now
        ) {
          return {
            released: false,
            bytes: 0,
          };
        }

        const bytes = Number(current.bytes);

        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
          await tx.contentWorkspaceStorageReservation.update({
            where: { id: reservation.id },
            data: {
              status: "RELEASED",
              releasedAt: now,
            },
          });

          return {
            released: true,
            bytes: 0,
          };
        }

        await lockWorkspaceUploadUsage(tx, current.creatorId);
        const usage = await tx.contentWorkspaceUsage.findUnique({
          where: {
            creatorId: current.creatorId,
          },
          select: {
            storageReservedBytes: true,
          },
        });

        if (!usage) {
          await tx.contentWorkspaceStorageReservation.update({
            where: { id: reservation.id },
            data: {
              status: "RELEASED",
              releasedAt: now,
            },
          });

          return {
            released: true,
            bytes: 0,
          };
        }

        const reservedBytes = Number(usage.storageReservedBytes);
        const releaseBytes = Math.min(reservedBytes, bytes);

        if (releaseBytes > 0) {
          await tx.contentWorkspaceUsage.update({
            where: {
              creatorId: current.creatorId,
            },
            data: {
              storageReservedBytes: {
                decrement: BigInt(releaseBytes),
              },
            },
          });
        }

        await tx.contentWorkspaceStorageReservation.update({
          where: {
            id: reservation.id,
          },
          data: {
            status: "RELEASED",
            releasedAt: now,
          },
        });

        return {
          released: true,
          bytes: releaseBytes,
        };
      });

      if (result.released) {
        released += 1;
        releasedBytes += result.bytes;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    processed: reservations.length,
    released,
    failed,
    releasedBytes,
  };
}
