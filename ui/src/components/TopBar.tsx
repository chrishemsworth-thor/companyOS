import { Menu } from "lucide-react";
import { NotificationBell } from "./NotificationBell";

/**
 * The console's top bar.
 *
 * Before PRD-007 there was a mobile-only header (hamburger + brand) and no
 * desktop header at all — the sidebar carried everything. The bell has to be on
 * *every* page, so this renders at all breakpoints: on mobile it keeps the
 * hamburger and brand it always had, and on desktop it is a thin right-aligned
 * strip holding just the bell.
 *
 * One bar, one mounted bell. Rendering a separate bell per breakpoint would mean
 * two components polling the same endpoint.
 */
export function TopBar({
  onOpenMenu,
  brand,
}: {
  onOpenMenu: () => void;
  brand: React.ReactNode;
}) {
  return (
    // `lg:ml-64` rather than padding: the desktop sidebar is `fixed inset-y-0`,
    // so a full-width bar would paint its background and bottom border straight
    // across the sidebar's brand. Offsetting the bar itself lines its border up
    // with the sidebar's right edge instead.
    <header className="safe-top sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:ml-64">
      <button
        aria-label="Open menu"
        onClick={onOpenMenu}
        className="-ml-1.5 cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg lg:hidden"
      >
        <Menu className="size-5" />
      </button>
      {/* The brand is the sidebar's job on desktop; repeating it here would be
          two logos on one screen. */}
      <div className="lg:hidden">{brand}</div>
      <div className="ml-auto flex items-center gap-1 lg:pr-6">
        <NotificationBell />
      </div>
    </header>
  );
}
