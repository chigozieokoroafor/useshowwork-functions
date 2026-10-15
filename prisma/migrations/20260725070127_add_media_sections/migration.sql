-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "sectionId" TEXT;

-- CreateTable
CREATE TABLE "MediaSection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaSection_projectId_idx" ON "MediaSection"("projectId");

-- AddForeignKey
ALTER TABLE "MediaSection" ADD CONSTRAINT "MediaSection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "MediaSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
