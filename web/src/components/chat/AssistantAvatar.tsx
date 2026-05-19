// Shared assistant-glyph avatar used by both MessageFeed (per-cluster header
// row) and MessageBubble (per-bubble glyph). Two sizes — `md` (28px container)
// matches the feed clustering header, `sm` (24px container) matches the
// tighter bubble layout. Default is `md` to preserve the MessageFeed usage
// the handoff named first.
//
// Pre-extraction this glyph existed as two identical-by-structure local
// functions in both files. Both consumers diverged only on container/glyph
// pixel sizing — the SVG path and ring/inner classes were duplicated.
export type AssistantAvatarSize = "sm" | "md";

const SIZE_CLASSES: Record<AssistantAvatarSize, { container: string; glyph: string }> = {
  sm: { container: "w-6 h-6", glyph: "w-3 h-3" },
  md: { container: "w-7 h-7", glyph: "w-3.5 h-3.5" },
};

export function AssistantAvatar({ size = "md" }: { size?: AssistantAvatarSize } = {}) {
  const { container, glyph } = SIZE_CLASSES[size];
  return (
    <div
      className={`${container} rounded-full avatar-ring flex items-center justify-center shrink-0 mt-0.5`}
      data-testid="assistant-avatar"
      data-size={size}
    >
      <div className="avatar-inner w-full h-full rounded-full flex items-center justify-center">
        <svg viewBox="0 0 16 16" fill="currentColor" className={`${glyph} text-cc-primary`}>
          <path d="M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z" />
        </svg>
      </div>
    </div>
  );
}
