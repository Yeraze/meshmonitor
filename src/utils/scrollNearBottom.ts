/**
 * Shared "is the scroll viewport near the bottom?" test for message streams.
 *
 * The distance from the current scroll position to the bottom of a container is
 * `scrollHeight - scrollTop - clientHeight`. When that distance is below
 * `threshold`, the viewport is close enough to the bottom that new content
 * should follow (auto-scroll) and the "jump to bottom" affordance should hide.
 *
 * Timing is the whole point (#6124): this value must be captured BEFORE a new
 * row commits to the DOM. Once React appends the row, `scrollHeight` grows by
 * the row's height, so a tall bubble pushes the measured distance past the
 * threshold even though the user was sitting right at the bottom — a
 * post-render false negative that stops the stream following new messages.
 * Callers therefore read this from a scroll handler (which reflects the
 * pre-commit layout) into a ref, and consult that ref in the post-commit
 * auto-scroll effect rather than re-measuring the already-grown container.
 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Default near-bottom threshold in pixels, aligned with the jump-to-bottom indicator. */
export const DEFAULT_NEAR_BOTTOM_THRESHOLD_PX = 100;

/**
 * Returns true when the container is within `threshold` pixels of the bottom.
 * A null/undefined container counts as "near bottom" so a stream with no
 * laid-out container defaults to following new messages.
 */
export function isNearBottom(
  metrics: ScrollMetrics | null | undefined,
  threshold: number = DEFAULT_NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  if (!metrics) return true;
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  return scrollHeight - scrollTop - clientHeight < threshold;
}
