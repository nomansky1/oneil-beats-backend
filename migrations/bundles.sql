-- Bundle pricing tiers — "Buy 3 leases for $69", "5 stems for $799" etc.
-- Powers the storefront bundle CTA + picker, and webhook fulfillment via the
-- existing /checkout flow (cart still resolves to N individual beats; we
-- just charge the bundle price as a single Stripe line item).
--
-- Run this in Supabase SQL Editor once before producers can configure bundles
-- from the desktop EXE admin "Bundles" tab.

CREATE TABLE IF NOT EXISTS bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,                          -- "3-Lease Bundle"
  license_type text NOT NULL CHECK (license_type IN ('lease','premium','stems')),
  qty int NOT NULL CHECK (qty >= 2 AND qty <= 20),
  price numeric(10,2) NOT NULL CHECK (price > 0),
  savings_label text,                           -- "Save $20.97" (display-only)
  description text,                             -- optional CTA copy
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,            -- lower = shown first
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bundles_active_sort_idx
  ON bundles(active, sort_order) WHERE active = true;

-- Row-level security — only service_role writes. Anonymous can SELECT active
-- bundles for the public storefront /bundles endpoint.
ALTER TABLE bundles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bundles_public_read ON bundles;
CREATE POLICY bundles_public_read ON bundles
  FOR SELECT
  USING (active = true);

-- Optional: seed two starter bundles so the storefront has something to show
-- the moment the producer flips Active=on. Comment these out if you'd rather
-- start empty and configure via the desktop EXE admin tab.
INSERT INTO bundles (label, license_type, qty, price, savings_label, description, sort_order)
VALUES
  ('3-Lease Starter Bundle',   'lease', 3, 69.00,  'Save ~$21 vs 3 single leases',   'Pick any 3 beats — instant MP3 delivery for all three.', 1),
  ('5-Stems Pro Pack',         'stems', 5, 799.00, 'Save ~$200 vs 5 single stems',   'Five full stems packs — every layer separated. For producers building tracks.', 2)
ON CONFLICT DO NOTHING;
