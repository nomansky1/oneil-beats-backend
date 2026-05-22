-- Drum kits — sellable sample packs extracted from existing beats.
-- Each row is one kit: Demucs isolates the drum bus of a beat, librosa slices
-- it into individual one-shots (kick/snare/hihat/perc), a genre MIDI pattern is
-- bundled in, AI artwork is generated, and the whole thing is zipped + uploaded.
-- The desktop EXE "Drum Kits" tab writes these; the storefront /kits page +
-- /kits API read them; checkout fulfils them as a single 'kit' line item.
--
-- Run once in the Supabase SQL Editor before generating the first kit.

CREATE TABLE IF NOT EXISTS drum_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beat_id uuid REFERENCES beats(id) ON DELETE SET NULL,  -- source beat (nullable: kit outlives beat)
  title text NOT NULL,                          -- "Luna Vibes Drum Kit"
  genre text,                                   -- copied from source beat at gen time
  bpm int,
  cover_url text,                               -- AI-generated kit artwork
  kit_url text NOT NULL,                         -- GCS/Supabase URL of the .zip
  price numeric(10,2) NOT NULL DEFAULT 9.99 CHECK (price >= 0),
  sample_count int NOT NULL DEFAULT 0,
  has_midi boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT false,         -- false = generated but not yet published
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One published kit per beat is the norm; allow regeneration by not making this
-- unique, but index for the storefront's "newest first" active listing.
CREATE INDEX IF NOT EXISTS drum_kits_active_created_idx
  ON drum_kits(active, created_at DESC) WHERE active = true;
CREATE INDEX IF NOT EXISTS drum_kits_beat_idx ON drum_kits(beat_id);

-- Row-level security — service_role writes (desktop EXE uses the service key);
-- anonymous can read only active kits for the public /kits storefront page.
ALTER TABLE drum_kits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drum_kits_public_read ON drum_kits;
CREATE POLICY drum_kits_public_read ON drum_kits
  FOR SELECT
  USING (active = true);
