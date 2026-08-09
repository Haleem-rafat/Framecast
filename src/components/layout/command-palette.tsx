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
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="text-muted-foreground relative h-9 w-full justify-start gap-2 pr-2 sm:w-64"
      >
        <Search className="size-4" />
        <span className="text-sm">Search…</span>
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
        <CommandList>
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
