-- A name for a run this process started and did not live to finish.
--
-- Not ERRORED, which means the machine never got the command started: an
-- abandoned run DID start, and may well have completed its work before the
-- restart landed on it. Telling the owner "we could not run it" about a backup
-- that in fact ran is the same class of lie TIMED_OUT exists to avoid.
--
-- Nothing writes this except the boot reconcile, which is also what stops a
-- RUNNING row from a dead process holding its job hostage forever.

ALTER TYPE "ScheduledRunStatus" ADD VALUE 'ABANDONED';
