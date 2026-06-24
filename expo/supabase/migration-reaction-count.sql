-- Add reaction_count column + trigger to posts table
-- Reactions are now separate posts linked via parent_post_id (no mehr stitching).
-- This trigger keeps reaction_count accurate on every insert/delete.

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS reaction_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION update_reaction_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_post_id IS NOT NULL THEN
      UPDATE public.posts SET reaction_count = reaction_count + 1 WHERE id = NEW.parent_post_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.parent_post_id IS NOT NULL THEN
      UPDATE public.posts SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = OLD.parent_post_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reaction_count ON public.posts;
CREATE TRIGGER trg_reaction_count
  AFTER INSERT OR DELETE ON public.posts
  FOR EACH ROW
  WHEN (NEW.parent_post_id IS NOT NULL OR OLD.parent_post_id IS NOT NULL)
  EXECUTE FUNCTION update_reaction_count();
