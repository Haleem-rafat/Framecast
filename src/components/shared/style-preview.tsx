"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A real 6-second clip of a style (public/looks/<name>.mp4, poster .jpg).
 * Plays while on screen, pauses off it, and stays still for anyone who asked
 * for reduced motion. Muted, so it never needs a gesture to start.
 */
export function StylePreview({
  name,
  label,
  className,
}: {
  /** File name under public/looks, without extension. */
  name: string;
  /** What the clip shows, for screen readers. */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => (entry?.isIntersecting ? void video.play().catch(() => {}) : video.pause()),
      { threshold: 0.4 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      src={`/looks/${name}.mp4`}
      poster={`/looks/${name}.jpg`}
      muted
      loop
      playsInline
      preload="none"
      aria-label={label}
      className={cn("aspect-[9/16] w-full rounded-lg bg-black object-cover", className)}
    />
  );
}
