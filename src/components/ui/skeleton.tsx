import { cn } from "@/lib/utils"

/**
 * `motion-reduce:animate-none` rather than `usePrefersReducedMotion()`.
 *
 * The hook exists (src/hooks/use-prefers-reduced-motion.ts) and is the right
 * tool when a *branch* depends on the preference — a different tree, a
 * different component. Here the only difference is whether one CSS animation
 * runs, and Tailwind's `motion-reduce:` variant is the identical media query
 * evaluated by the browser itself.
 *
 * That distinction matters more than it looks. Almost every skeleton in this
 * app is rendered from a `loading.tsx`, which is a server component: reading
 * the preference in React would make `Skeleton` a client component, and with
 * it every loading boundary that uses one — so the placeholder whose entire
 * job is to appear before any JavaScript has run would start depending on
 * JavaScript having run. It would also flash the animation for one frame
 * before hydration corrected it, which is the exact motion the preference asks
 * not to see. The media query has none of those problems and costs nothing.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-muted motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
