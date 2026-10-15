/*
  Warnings:

  - A unique constraint covering the columns `[paystackReference]` on the table `PaymentRecord` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_paystackReference_key" ON "PaymentRecord"("paystackReference");
