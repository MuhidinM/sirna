/**
 * One page of a newest-first list (Settings → What was sent shows 10 calls a
 * page with Newer / Older). Pages count from 0 = the newest; a page past the
 * end (the list shrank) falls back to the last page.
 */
export interface Page {
  /** The page actually shown, after clamping. */
  page: number;
  start: number;
  end: number;
  hasNewer: boolean;
  hasOlder: boolean;
  /** "1–10 of 37"; empty when there is nothing. */
  label: string;
}

export const SENT_PAGE_SIZE = 10;

export function pageOf(total: number, page: number, size = SENT_PAGE_SIZE): Page {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  const shown = Math.min(Math.max(0, Math.floor(page)), last);
  const start = Math.min(shown * size, total);
  const end = Math.min(start + size, total);
  return {
    page: shown,
    start,
    end,
    hasNewer: shown > 0,
    hasOlder: end < total,
    label: total === 0 ? "" : `${start + 1}–${end} of ${total}`,
  };
}
