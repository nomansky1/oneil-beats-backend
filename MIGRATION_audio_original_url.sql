-- Run once in Supabase SQL editor:
-- https://supabase.com/dashboard/project/thmqqplnrjwimgqubkhp/sql
-- Adds a column to store the untagged original MP3 URL so customers receive
-- the clean audio on purchase while the public preview plays the tagged version.

ALTER TABLE beats
  ADD COLUMN IF NOT EXISTS audio_original_url TEXT;

-- For existing beats (uploaded before the tag pipeline), audio_original_url
-- stays NULL — the backend falls back to audio_url so nothing breaks.
