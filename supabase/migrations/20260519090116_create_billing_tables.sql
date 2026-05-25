/*
  # Billing Tables

  ## Summary
  Adds server-authoritative billing persistence so Apocrita plan state
  survives Redis outages, device changes, and re-logins — and so payment
  history is permanently auditable.

  ## New Tables

  ### `subscriptions`
  One row per Apocrita user. Tracks the current plan, Stripe customer/
  subscription IDs, and billing status. This is the SINGLE SOURCE OF TRUTH
  for whether a user has a paid plan. No client-side claim can override it.

  - `id`              (uuid, PK)
  - `email`           (text, unique, indexed) — normalised lowercase email
  - `plan`            (text, default 'starter') — starter | basic | premium | ultimate
  - `billing_status`  (text, default 'inactive') — inactive | active | trialing | cancelled | past_due
  - `stripe_customer_id`    (text, nullable, indexed)
  - `stripe_subscription_id` (text, nullable, unique)
  - `current_period_end`    (timestamptz, nullable) — next renewal / end of paid period
  - `created_at`      (timestamptz)
  - `updated_at`      (timestamptz)

  ### `billing_events`
  Immutable append-only log of every Stripe webhook event processed.
  Used for idempotency (deduplication), audit, and debugging.

  - `id`           (uuid, PK)
  - `stripe_event_id` (text, unique) — Stripe's own event ID (used for idempotency)
  - `event_type`   (text) — e.g. checkout.session.completed
  - `email`        (text, nullable)
  - `plan`         (text, nullable)
  - `status`       (text) — processed | failed | skipped
  - `raw`          (jsonb) — full Stripe event object for auditing
  - `created_at`   (timestamptz)

  ## Security
  - RLS enabled on both tables
  - Subscriptions: authenticated users can read their own row only
  - Subscriptions: only service_role can insert/update (webhooks write via service role)
  - Billing events: service_role only (fully server-side audit log)

  ## Notes
  1. `stripe_subscription_id` has a UNIQUE constraint so duplicate webhook
     events cannot create duplicate rows
  2. `billing_events.stripe_event_id` UNIQUE ensures webhook idempotency —
     re-delivered events are safely rejected with a conflict, not double-processed
  3. `subscriptions.email` is indexed for fast lookup by email (the primary
     lookup key used by the webhook handler and plan endpoint)
*/

-- ===== SUBSCRIPTIONS =====

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   text        UNIQUE NOT NULL,
  plan                    text        NOT NULL DEFAULT 'starter',
  billing_status          text        NOT NULL DEFAULT 'inactive',
  stripe_customer_id      text,
  stripe_subscription_id  text        UNIQUE,
  current_period_end      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_email_idx
  ON subscriptions(email);

CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_idx
  ON subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscription"
  ON subscriptions FOR SELECT
  TO authenticated
  USING (
    email = (
      SELECT email FROM profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Service role can insert subscriptions"
  ON subscriptions FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update subscriptions"
  ON subscriptions FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ===== BILLING EVENTS =====

CREATE TABLE IF NOT EXISTS billing_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text        UNIQUE NOT NULL,
  event_type      text        NOT NULL,
  email           text,
  plan            text,
  status          text        NOT NULL DEFAULT 'processed',
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_events_email_idx
  ON billing_events(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_events_stripe_event_idx
  ON billing_events(stripe_event_id);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can insert billing events"
  ON billing_events FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can select billing events"
  ON billing_events FOR SELECT
  TO service_role
  USING (true);
