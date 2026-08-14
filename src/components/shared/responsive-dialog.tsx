"use client";

import { createContext, useContext, type ReactNode } from "react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * One dialog that is a centred modal on a desktop and a bottom sheet on a
 * phone.
 *
 * A centred modal is the wrong shape for a form on a phone for a mechanical
 * reason, not an aesthetic one: it is `position: fixed` and vertically
 * centred, so when the on-screen keyboard opens it is the *middle* of the
 * dialog that stays put — the field being typed into slides under the
 * keyboard, and the submit button goes with it. A sheet anchored to the bottom
 * edge rises with the keyboard instead, which is why every native form does it
 * that way.
 *
 * The swap is decided by `useIsMobile`, which reports `false` until it has
 * measured — so the first paint is the dialog and a phone remounts to the
 * drawer. That only ever happens while the surface is closed, since the
 * measurement lands long before anything is opened.
 *
 * Component-for-component drop-in for `@/components/ui/dialog`: same names
 * with a `Responsive` prefix, same children, so converting a dialog is an
 * import change.
 */
const MobileContext = createContext(false);

function useIsSheet(): boolean {
  return useContext(MobileContext);
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const Root = isMobile ? Drawer : Dialog;

  return (
    <MobileContext.Provider value={isMobile}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </MobileContext.Provider>
  );
}

export function ResponsiveDialogTrigger({
  children,
  asChild,
}: {
  children: ReactNode;
  asChild?: boolean;
}) {
  const Trigger = useIsSheet() ? DrawerTrigger : DialogTrigger;

  return <Trigger asChild={asChild}>{children}</Trigger>;
}

export function ResponsiveDialogContent({
  className,
  children,
}: {
  /** Applied to the desktop dialog only — the sheet is always full width. */
  className?: string;
  children: ReactNode;
}) {
  const isSheet = useIsSheet();

  if (isSheet) {
    return (
      // Never taller than the viewport, and never *under* the home indicator:
      // the footer of a sheet is where the submit button is.
      // The sheet scrolls as a whole rather than only in its body: callers
      // wrap their header, body and footer in one `<form>`, which would
      // otherwise sit between the flex container and the region that needs the
      // height constraint, and a scroll region that is never taller than its
      // content does nothing at all.
      <DrawerContent className="max-h-[92dvh] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {children}
      </DrawerContent>
    );
  }

  return <DialogContent className={className}>{children}</DialogContent>;
}

export function ResponsiveDialogHeader({ children }: { children: ReactNode }) {
  const Header = useIsSheet() ? DrawerHeader : DialogHeader;

  return <Header>{children}</Header>;
}

export function ResponsiveDialogTitle({ children }: { children: ReactNode }) {
  const Title = useIsSheet() ? DrawerTitle : DialogTitle;

  return <Title>{children}</Title>;
}

export function ResponsiveDialogDescription({
  children,
}: {
  children: ReactNode;
}) {
  const Description = useIsSheet() ? DrawerDescription : DialogDescription;

  return <Description>{children}</Description>;
}

export function ResponsiveDialogBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const isSheet = useIsSheet();

  if (isSheet) {
    // Just the fields and their padding — the sheet itself owns the scroll.
    return (
      <div className={cn("space-y-4 px-4", className)}>
        {children}
      </div>
    );
  }

  return <DialogBody className={className}>{children}</DialogBody>;
}

export function ResponsiveDialogFooter({ children }: { children: ReactNode }) {
  const Footer = useIsSheet() ? DrawerFooter : DialogFooter;

  return <Footer>{children}</Footer>;
}
