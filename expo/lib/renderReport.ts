/**
 * One short message (about 6 s) describing what the render path did for the
 * post that was just published. Internal testers only (callers check).
 */
type Listener = (message: string | null) => void;

const SHOW_MS = 6000;
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

export function reportRender(message: string): void {
  current = message;
  listeners.forEach((l) => l(current));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    listeners.forEach((l) => l(null));
  }, SHOW_MS);
}

export function subscribeRenderReport(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
