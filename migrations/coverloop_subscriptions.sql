-- coverloop_subscriptions — CoverLoop desktop-app subscription state.
-- One row per customer email. Written by the Stripe webhook
-- (checkout.session.completed mode=subscription + customer.subscription.updated/
-- deleted); read by the desktop app's entitlement check (GET /coverloop/subscription).
--
-- Run once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS coverloop_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'inactive',   -- active | trialing | past_due | canceled | inactive
  current_period_end timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coverloop_subs_sub_idx
  ON coverloop_subscriptions(stripe_subscription_id);

-- RLS on with NO public policy: anon / PostgREST cannot read billing status.
-- The backend reads/writes via the direct Postgres pooler role, which bypasses RLS.
ALTER TABLE coverloop_subscriptions ENABLE ROW LEVEL SECURITY;
