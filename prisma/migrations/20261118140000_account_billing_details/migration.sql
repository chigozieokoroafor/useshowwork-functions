CREATE TABLE "AccountBillingDetails" (
  "creatorId" TEXT PRIMARY KEY,
  "name" TEXT,
  "email" TEXT,
  "address" TEXT,
  "taxId" TEXT,
  CONSTRAINT "AccountBillingDetails_creatorId_fkey" FOREIGN KEY ("creatorId")
    REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
