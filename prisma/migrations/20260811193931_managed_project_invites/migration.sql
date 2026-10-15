-- CreateTable
CREATE TABLE "ManagedProjectInvite" (
    "id" TEXT NOT NULL,
    "managedProjectId" TEXT NOT NULL,
    "invitedByCreatorId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "ManagedProjectInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedProjectInvite_tokenHash_key" ON "ManagedProjectInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "ManagedProjectInvite_managedProjectId_idx" ON "ManagedProjectInvite"("managedProjectId");

-- CreateIndex
CREATE INDEX "ManagedProjectInvite_email_idx" ON "ManagedProjectInvite"("email");

-- AddForeignKey
ALTER TABLE "ManagedProjectInvite" ADD CONSTRAINT "ManagedProjectInvite_managedProjectId_fkey" FOREIGN KEY ("managedProjectId") REFERENCES "ManagedProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedProjectInvite" ADD CONSTRAINT "ManagedProjectInvite_invitedByCreatorId_fkey" FOREIGN KEY ("invitedByCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
