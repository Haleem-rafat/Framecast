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
        // fully lit, so the dialog read as a pale card floating over live
        // content instead of as a focused, separate layer.
        "fixed inset-0 isolate z-50 bg-black/50 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Three fixed regions, not one scrolling box: DialogHeader, DialogBody and
 * DialogFooter are laid out as a column where only the body scrolls. The
 * earlier design stuck the header and footer to a single scroll container,
 * which meant content slid *underneath* them and, because a sticky element is
 * constrained by its parent's box rather than the scrollport, the footer rode
 * along with the content whenever a consumer wrapped its children in a
 * `<form>` — which all of them do.
 *
 * `[&>form]:contents` is what makes that wrapper stop mattering: the form no
 * longer generates a layout box, so header, body and footer become direct
 * children of this column. Submission and validation are unaffected —
 * `display: contents` removes the box, not the element.
 *
 * `p-0` because the padding belongs to each region; that is what lets the
 * header and footer bars span edge to edge while their content stays inset.
 * `overflow-hidden` clips those bars to the rounded corners.
 */
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
          // `dvh` rather than `vh` so a mobile URL bar appearing does not push
          // the dialog past the bottom of the screen. The height ceiling is
          // what forces DialogBody to scroll instead of the dialog growing off
          // both edges, where nothing could scroll it back into reach.
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-popover p-0 text-popover-foreground shadow-2xl shadow-black/20 ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [&>form]:contents",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-3.5 right-3.5 z-20 text-muted-foreground hover:text-foreground"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/** Fixed top region. `shrink-0` keeps it at its natural height while the body
 *  absorbs the shrinking; `pr-12` reserves room for the close button so a long
 *  title cannot run underneath it. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b px-6 pt-5 pr-12 pb-3",
        className
      )}
      {...props}
    />
  )
}

/**
 * The only region that scrolls. `min-h-0` is what allows a flex item to shrink
 * below its content — without it the body keeps its full height, the column
 * overflows the dialog's max-height, and `overflow-hidden` clips the footer
 * off the bottom of the screen rather than the body scrolling.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4",
        className
      )}
      {...props}
    />
  )
}

/** Fixed bottom region, mirroring the header. */
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
        "flex shrink-0 flex-col-reverse gap-2 border-t bg-popover px-6 py-3 *:[button]:h-8 sm:flex-row sm:justify-end sm:gap-2",
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
        // At text-base/medium the title sat at almost the same size and weight
        // as the description beneath it, so a dialog opened with no focal point.
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
  DialogBody,
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
