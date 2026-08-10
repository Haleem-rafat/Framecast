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
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
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
          // The overflow lives on the inner wrapper, not here: the close button
          // is absolutely positioned against this box, and an absolute child of
          // a scrolling ancestor scrolls away with the content. Scrolling the
          // body instead keeps the close button pinned.
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {/* `min-h-0` — a grid item will not shrink below its content without it,
            which would defeat the max-height above. DialogHeader/DialogFooter
            pin themselves with `sticky` from inside this container instead of
            this div splitting into header/body/footer regions — that way any
            consumer's children work without being restructured, and the close
            button below stays exempt from the scroll for the reason above. */}
        <div className="grid min-h-0 gap-4 overflow-y-auto overscroll-contain">
          {children}
        </div>
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              // z-20: above the sticky header/footer's z-10, so it stays
              // clickable even when one of them is pinned under it.
              className="absolute top-2 right-2 z-20"
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
        // `sticky top-0` pins this to the top of the scroll container above
        // instead of it scrolling away with the body on a tall dialog. The
        // `-mx-4 -mt-4` + `px-4 pt-4` pair cancels and re-applies the parent's
        // padding so the header's own opaque background extends flush to the
        // dialog's edges (matching DialogFooter below) instead of leaving a
        // gap the scrolled body would show through.
        "sticky top-0 z-10 -mx-4 -mt-4 flex flex-col gap-2 rounded-t-xl bg-popover px-4 pt-4",
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
        // `sticky bottom-0` pins this to the bottom of the scroll container
        // above instead of it scrolling away with the body on a tall dialog.
        // The background must stay opaque (not translucent) once pinned, or
        // body content scrolling underneath would show through it.
        "sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col-reverse gap-2.5 rounded-b-xl border-t bg-muted p-4 sm:flex-row sm:justify-end sm:gap-3",
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
        "font-heading text-base leading-none font-medium",
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
