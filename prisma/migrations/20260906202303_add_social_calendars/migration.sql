-- CreateEnum
CREATE TYPE "CalendarPlanStatus" AS ENUM ('BUILDING', 'AWAITING_APPROVAL', 'PLAN_APPROVED', 'PLAN_NEEDS_CHANGES');

-- CreateEnum
CREATE TYPE "CalendarBillingStatus" AS ENUM ('PENDING_SETUP', 'ACTIVE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK', 'X', 'LINKEDIN');

-- CreateEnum
CREATE TYPE "PostApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'NEEDS_REVISION');

-- AlterEnum
ALTER TYPE "AccountType" ADD VALUE 'SOCIAL_MEDIA_MANAGER';

-- CreateTable
CREATE TABLE "SocialCalendar" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "planStatus" "CalendarPlanStatus" NOT NULL DEFAULT 'BUILDING',
    "planSubmittedAt" TIMESTAMP(3),
    "planApprovedAt" TIMESTAMP(3),
    "planApprovalNote" TEXT,
    "passwordHash" TEXT NOT NULL,
    "accessCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "managerId" TEXT NOT NULL,
    "billingStatus" "CalendarBillingStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "paystackSubscriptionCode" TEXT,
    "paystackEmailToken" TEXT,
    "paystackCustomerCode" TEXT,
    "subscriptionRenewsAt" TIMESTAMP(3),
    "pendingSubscriptionRef" TEXT,
    "wentOfflineAt" TIMESTAMP(3),
    "lastPaymentReminderSentAt" TIMESTAMP(3),

    CONSTRAINT "SocialCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarPost" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "postDate" TIMESTAMP(3) NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "postType" TEXT,
    "caption" TEXT,
    "contentIdea" TEXT,
    "fileKey" TEXT,
    "mediaType" "MediaType",
    "approvalStatus" "PostApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvalNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarPostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorName" TEXT,
    "authorEmail" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarPostVideoComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorName" TEXT,
    "authorEmail" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "videoTimestampSeconds" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarPostVideoComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarCollaborator" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarInvite" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "invitedByCreatorId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarViewerEmail" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarViewerEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialCalendar_slug_key" ON "SocialCalendar"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SocialCalendar_pendingSubscriptionRef_key" ON "SocialCalendar"("pendingSubscriptionRef");

-- CreateIndex
CREATE INDEX "SocialCalendar_managerId_idx" ON "SocialCalendar"("managerId");

-- CreateIndex
CREATE INDEX "CalendarPost_calendarId_idx" ON "CalendarPost"("calendarId");

-- CreateIndex
CREATE INDEX "CalendarPost_calendarId_postDate_idx" ON "CalendarPost"("calendarId", "postDate");

-- CreateIndex
CREATE INDEX "CalendarPostComment_postId_idx" ON "CalendarPostComment"("postId");

-- CreateIndex
CREATE INDEX "CalendarPostVideoComment_postId_idx" ON "CalendarPostVideoComment"("postId");

-- CreateIndex
CREATE INDEX "CalendarCollaborator_calendarId_idx" ON "CalendarCollaborator"("calendarId");

-- CreateIndex
CREATE INDEX "CalendarCollaborator_creatorId_idx" ON "CalendarCollaborator"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarCollaborator_calendarId_creatorId_key" ON "CalendarCollaborator"("calendarId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarInvite_tokenHash_key" ON "CalendarInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "CalendarInvite_calendarId_idx" ON "CalendarInvite"("calendarId");

-- CreateIndex
CREATE INDEX "CalendarInvite_email_idx" ON "CalendarInvite"("email");

-- CreateIndex
CREATE INDEX "CalendarViewerEmail_calendarId_idx" ON "CalendarViewerEmail"("calendarId");

-- AddForeignKey
ALTER TABLE "SocialCalendar" ADD CONSTRAINT "SocialCalendar_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarPost" ADD CONSTRAINT "CalendarPost_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarPostComment" ADD CONSTRAINT "CalendarPostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarPostVideoComment" ADD CONSTRAINT "CalendarPostVideoComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarCollaborator" ADD CONSTRAINT "CalendarCollaborator_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarCollaborator" ADD CONSTRAINT "CalendarCollaborator_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarInvite" ADD CONSTRAINT "CalendarInvite_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarInvite" ADD CONSTRAINT "CalendarInvite_invitedByCreatorId_fkey" FOREIGN KEY ("invitedByCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarViewerEmail" ADD CONSTRAINT "CalendarViewerEmail_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
