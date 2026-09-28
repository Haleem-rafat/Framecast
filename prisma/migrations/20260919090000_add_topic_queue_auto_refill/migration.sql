-- The topic queue fills itself.
--
-- A schedule took the next topic off its queue each run and paused itself when
-- the queue ran out, saying "nothing here invents a subject". Several of the
-- owner's schedules sat paused that way, and typing topics by hand was the one
-- part of this product they most wanted gone. So the queue is now topped up
-- ahead of time — below three remaining topics, ten more are generated and
-- appended — and the empty-queue pause is gone with it.
--
-- Four columns, and none of them is a switch. This is on for every schedule and
-- every series, because a feature whose entire purpose is that nobody has to
-- think about the queue cannot start by asking whether they would like to.
--
-- ## schedule_topic.generated
--
-- Which topics the operator did not write. Needed on screen — the queue has to
-- be able to say "these four are ours" rather than leaving somebody to work out
-- what they typed three weeks ago — and needed afterwards, because joining
-- generated topics to the views their videos got is the only way to ever answer
-- whether the auto-fill picked well.
--
-- Defaults to false, which backfills every existing row to exactly what it is:
-- something a person wrote.
--
-- ## schedule.topicRefillLeaseExpiresAt
--
-- One refill at a time per schedule. A separate lease from `claimExpiresAt`
-- rather than a reuse of it, because the two deliberately overlap: the run path
-- tops the queue up while it already holds the run claim, so a refill that took
-- that same lease could never take it. What this one prevents is the case that
-- costs money — two workers both deciding one queue is low and both generating
-- ten topics for it, which is a wasted model call and twenty topics where the
-- operator was promised ten.
--
-- Nullable with no default: null means "free", which is the state every existing
-- row is in.
--
-- ## schedule.topicRefillFailures / topicRefillNextAttemptAt
--
-- Backoff for a provider that is down. The slow tick runs whenever the worker is
-- idle, which on a quiet box is continuously, so a failing refill without a gate
-- would be a 402 every ten seconds.
--
-- Deliberately NOT folded into `consecutiveFailures`. That counter pauses a
-- schedule at three, and a failed refill has not failed to produce a video —
-- counting it there would let a rate limit hit during a tick disarm a schedule
-- whose queue is perfectly full. These two columns gate retries and nothing
-- else; the only thing that pauses a schedule over topics is a run that is
-- actually due, finding the queue actually empty, after a refill that actually
-- failed.
ALTER TABLE "schedule_topic"
  ADD COLUMN "generated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "schedule"
  ADD COLUMN "topicRefillLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "topicRefillFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "topicRefillNextAttemptAt" TIMESTAMP(3);
