-- Subscription state, with no processor attached to it yet.
--
-- plan.md 9.4: everything about billing except the two calls that need a key
-- somebody else owns. The webhook is the only writer of this state -- the
-- post-checkout redirect is a browser event and proves nothing -- and events
-- are recorded by the processor's own id so an at-least-once redelivery is
-- dropped by a unique index rather than by hoping.
--
-- What an account may DO is not decided here. This decides users.planId, and
-- every limit in the product already resolves from that.

CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED');

CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "planId" TEXT NOT NULL,
    "customerId" TEXT,
    "subscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions" ("userId");
CREATE UNIQUE INDEX "subscriptions_customerId_key" ON "subscriptions" ("customerId");
CREATE UNIQUE INDEX "subscriptions_subscriptionId_key" ON "subscriptions" ("subscriptionId");
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" ("status");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The event id IS the primary key: there is no second identity for this row,
-- and a generated one would let two copies of the same event exist.
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_events_receivedAt_idx" ON "billing_events" ("receivedAt");

-- The two moments a person can act on: a payment failed, or the plan has gone.
-- Nothing between them, because a renewal that works is not news.
ALTER TYPE "NotificationKind" ADD VALUE 'BILLING_PROBLEM';
