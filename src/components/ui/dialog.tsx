"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // `black/50`, not `black/10`. At 10% the page behind stayed almost
        // fully lit, so the dialog read as a pale card floating on live
        // content instead of as a focused, separate layer.
        "fixed inset-0 isolate z-50 bg-black/50 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // A centred `fixed` box with no height ceiling grows past both edges of
          // the viewport, and because it is translated rather than laid out, the
          // page cannot scroll to reach what overflows — the submit button ends
          // up unreachable. `dvh` rather than `vh` so a mobile URL bar
          // appearing does not reintroduce the same cut-off.
          //
          // `sm:max-w-md`, not `sm:max-w-sm`: every dialog
          // in this app is a form (a select plus two or three labelled
          // in this app is a form, and 384px left the fields cramped.
          //
          // No `text-sm` on the container either. Setting a base size here
          // shrank titles and labels along with body copy, which flattened
          // every dialog into one uniform small size with no hierarchy —
          // DialogTitle and DialogDescription set their own sizes instead.
          // `p-0` and `overflow-hidden`: the padding belongs to the three
          // regions inside, not to this box. That is what lets the header and
          // footer bars run edge to edge while their text stays inset, and
          // `overflow-hidden` is what clips those full-bleed bars to the
          // rounded corners instead of letting them square off the top and
          // bottom of the dialog.
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-popover p-0 text-popover-foreground shadow-2xl shadow-black/20 ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {/* `overflow-x-clip` is load-bearing: the header and footer below use a
            negative horizontal margin to reach the dialog's edges, which makes
            them wider than this container — and a container with
            `overflow-y: auto` and a visible x-axis resolves x to `auto` too,
            so the whole dialog gained a horizontal scrollbar. Clipping x kills
            that without clipping the sticky positioning the way
            `overflow-x: hidden` on some ancestors would.

            The horizontal padding lives here rather than on the box outside,
            so ordinary content is inset while those two bars are not. */}
        <div className="grid min-h-0 gap-4 overflow-y-auto overflow-x-clip overscroll-contain px-6 pb-6">
          {children}
        </div>
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              // z-20: above the sticky header/footer's z-10, so it stays
              // clickable even when one of them is pinned under it.
              className="absolute top-4 right-4 z-20 text-muted-foreground hover:text-foreground"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        // `-mx-6 px-6` gives a bar that spans the dialog edge to edge while its
        // text stays inset, and `border-b` draws the line the content scrolls
        // under. `pr-12` keeps the title clear of the close button.
        "sticky top-0 z-10 -mx-6 flex flex-col gap-1.5 border-b bg-popover px-6 pt-6 pr-12 pb-4",
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // Mirrors the header: full-bleed bar, inset content, a rule the body
        // scrolls under. `-mb-6` cancels the scroll container's bottom padding
        // so the bar sits flush against the dialog's bottom edge.
        "sticky bottom-0 z-10 -mx-6 -mb-6 mt-1 flex flex-col-reverse gap-2.5 border-t bg-popover px-6 py-4 sm:flex-row sm:justify-end sm:gap-3",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        // `text-lg` + `font-semibold`: at text-base/medium the title sat at
        // almost the same weight and size as the description under it, so a
        // dialog opened with no clear focal point.
        "font-heading text-lg leading-tight font-semibold tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
