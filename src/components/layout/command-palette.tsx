"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, Search, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { navigation } from "@/config/navigation";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme } = useTheme();

  useKeyboardShortcut("k", () => setOpen((previous) => !previous), {
    meta: true,
  });

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  // Warm the router cache for top-level routes so palette navigation is
  // instant. Unbuilt routes have no page to prefetch.
  useEffect(() => {
    if (!open) return;
    for (const group of navigation) {
      for (const item of group.items) {
        if (item.built) router.prefetch(item.href);
      }
    }
  }, [open, router]);

  return (
    <>
      {/* Below `sm` this is the icon alone at a 44px target: the phone topbar
       * has room for a control, not for a search field that would push the
       * page title off the bar. The dialog it opens is identical either way,
       * and on a phone it is the only way to reach the pages the dock's four
       * slots could not hold. */}
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="text-muted-foreground relative size-11 justify-center gap-0 p-0 sm:h-9 sm:w-64 sm:justify-start sm:gap-2 sm:px-3 sm:pr-2"
      >
        <Search className="size-4" />
        <span className="hidden text-sm sm:inline">Search…</span>
        <kbd className="bg-muted text-muted-foreground pointer-events-none ml-auto hidden h-5 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Jump to a page or run a command"
      >
        <CommandInput placeholder="Search pages and commands…" />
        {/* One rule rather than a class on twenty items: on a touch device
         * every result is a 44px target, and the desktop list keeps the
         * compact rows a keyboard-driven palette wants. */}
        <CommandList className="[@media(pointer:coarse)]:[&_[data-slot=command-item]]:h-11">
          <CommandEmpty>No results found.</CommandEmpty>

          {navigation.map((group) => {
            // Unbuilt items have no page to jump to — leaving them out of
            // search results is safer than showing a disabled row a fuzzy
            // matcher might still let the user "select".
            const builtItems = group.items.filter((item) => item.built);
            if (builtItems.length === 0) return null;

            return (
              <CommandGroup key={group.label} heading={group.label}>
                {builtItems.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`${item.title} ${item.keywords?.join(" ") ?? ""}`}
                    onSelect={() => runCommand(() => router.push(item.href))}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}

          <CommandSeparator />

          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => runCommand(() => setTheme("light"))}>
              <Sun />
              Light
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme("dark"))}>
              <Moon />
              Dark
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme("system"))}>
              <Monitor />
              System
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
