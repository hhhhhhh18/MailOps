-- CreateEnum
CREATE TYPE "DeletionInitiator" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "AccountDeletionRecord" (
    "id" TEXT NOT NULL,
    "deletedUserIdHash" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "initiator" "DeletionInitiator" NOT NULL DEFAULT 'USER',
    "countsByModel" JSONB NOT NULL DEFAULT '{}',
    "gmailGrantRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokeFailures" JSONB,
    "requestedByIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionRecord_requestedAt_idx" ON "AccountDeletionRecord"("requestedAt");

-- CreateIndex
CREATE INDEX "AccountDeletionRecord_deletedUserIdHash_idx" ON "AccountDeletionRecord"("deletedUserIdHash");