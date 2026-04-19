-- Add description column for AI-generated beat descriptions (editable)
ALTER TABLE beats ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
