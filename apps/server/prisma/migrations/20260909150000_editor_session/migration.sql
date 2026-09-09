-- Where the editor was left, against the account rather than the browser.
-- plan.md §13.11.
--
-- The mapped table name, not the model name: `@@map` means Prisma's model is
-- `UserEditorState` and the table is `user_editor_state`. A migration written
-- against the model name ships green and fails the first time it is run, which
-- is a defect class this repository has recorded (plan.md §5).
CREATE TABLE "user_editor_state" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_editor_state_pkey" PRIMARY KEY ("userId", "key")
);

-- Cascade, so deleting an account takes its editor state with it. Layout and
-- preferences have no meaning without the person they belong to.
ALTER TABLE "user_editor_state"
    ADD CONSTRAINT "user_editor_state_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
