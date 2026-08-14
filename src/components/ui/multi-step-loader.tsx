"use client";
/**
 * Aceternity's Multi Step Loader.
 *
 * Adapted from upstream:
 * - `value` turns the step index into a controlled prop and, in doing so,
 *   switches off the internal timer entirely. See `MultiStepLoader`'s own doc
 *   comment for why that matters more here than anywhere it is usually used.
 * - `onClose` renders a dismiss control, because this is a full-screen
 *   overlay and the process it reports on takes minutes rather than seconds.
 * - The registry lists `@tabler/icons-react` as a dependency, but only its
 *   demo ever imported it. It was uninstalled again; icons here are lucide,
 *   like the rest of the project — the same call bento-grid.tsx already made.
 */
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useState, useEffect } from "react";
import { X } from "lucide-react";

const CheckIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={cn("w-6 h-6 ", className)}
    >
      <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
};

const CheckFilled = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("w-6 h-6 ", className)}
    >
      <path
        fillRule="evenodd"
        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
        clipRule="evenodd"
      />
    </svg>
  );
};

type LoadingState = {
  text: string;
};

const LoaderCore = ({
  loadingStates,
  value = 0,
}: {
  loadingStates: LoadingState[];
  value?: number;
}) => {
  return (
    <div className="flex relative justify-start max-w-xl mx-auto flex-col mt-40">
      {loadingStates.map((loadingState, index) => {
        const distance = Math.abs(index - value);
        const opacity = Math.max(1 - distance * 0.2, 0); // Minimum opacity is 0, keep it 0.2 if you're sane.

        return (
          <motion.div
            key={index}
            className={cn("text-left flex gap-2 mb-4")}
            initial={{ opacity: 0, y: -(value * 40) }}
            animate={{ opacity: opacity, y: -(value * 40) }}
            transition={{ duration: 0.5 }}
          >
            <div>
              {index > value && (
                <CheckIcon className="text-black dark:text-white" />
              )}
              {index <= value && (
                <CheckFilled
                  className={cn(
                    "text-black dark:text-white",
                    value === index &&
                      "text-black dark:text-lime-500 opacity-100"
                  )}
                />
              )}
            </div>
            <span
              className={cn(
                "text-black dark:text-white",
                value === index && "text-black dark:text-lime-500 opacity-100"
              )}
            >
              {loadingState.text}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
};

/**
 * Two additions to the upstream Aceternity component, both deliberate.
 *
 * `value` makes it *controlled*. Upstream, the current step advances on a
 * `setTimeout` every `duration` milliseconds — the step list is an animation,
 * not a status. That is fine for a marketing demo and actively harmful
 * anywhere a real process is being reported on: the timer would tick "Render"
 * green while nothing is rendering, march past a stage that failed, and reach
 * the end while the work has not started. Passing `value` therefore does more
 * than seed the index — it disables the timer entirely (see the early return
 * in the effect), so a controlled caller can never accidentally get
 * auto-advance back by also passing `duration` or `loop`.
 *
 * `onClose` exists because this renders a full-screen, `z-[100]` overlay. A
 * two-second demo can get away with no way out; a process that takes minutes
 * cannot, and the work here continues on a background worker whether or not
 * anyone is watching it.
 */
export const MultiStepLoader = ({
  loadingStates,
  loading,
  duration = 2000,
  loop = true,
  value,
  onClose,
}: {
  loadingStates: LoadingState[];
  loading?: boolean;
  duration?: number;
  loop?: boolean;
  /** Controlled current-step index. Supplying it disables auto-advance. */
  value?: number;
  /** Renders a dismiss control. Omit for an overlay that cannot be closed. */
  onClose?: () => void;
}) => {
  const [autoState, setAutoState] = useState(0);
  const isControlled = value !== undefined;

  useEffect(() => {
    if (isControlled) return;

    if (!loading) {
      setAutoState(0);
      return;
    }
    const timeout = setTimeout(() => {
      setAutoState((prevState) =>
        loop
          ? prevState === loadingStates.length - 1
            ? 0
            : prevState + 1
          : Math.min(prevState + 1, loadingStates.length - 1)
      );
    }, duration);

    return () => clearTimeout(timeout);
  }, [autoState, isControlled, loading, loop, loadingStates.length, duration]);

  const currentState = isControlled ? value : autoState;

  return (
    <AnimatePresence mode="wait">
      {loading && (
        <motion.div
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          exit={{
            opacity: 0,
          }}
          className="w-full h-full fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-2xl"
        >
          <div className="h-96  relative">
            <LoaderCore value={currentState} loadingStates={loadingStates} />
          </div>

          <div className="bg-gradient-to-t inset-x-0 z-20 bottom-0 bg-white dark:bg-black h-full absolute [mask-image:radial-gradient(900px_at_center,transparent_30%,white)]" />

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Hide progress"
              className="text-muted-foreground hover:text-foreground absolute top-4 right-4 z-30 rounded-md p-2"
            >
              <X className="size-5" />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
