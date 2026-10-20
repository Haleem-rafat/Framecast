import type { CSSProperties, ReactElement, ReactNode } from "react";

/** Types for the React Bits InfiniteMenu (InfiniteMenu.jsx), from its props table. */
export interface InfiniteMenuItem {
  image: string;
  title?: string;
  description?: string;
  link?: string;
}

export interface InfiniteMenuProps<T extends InfiniteMenuItem = InfiniteMenuItem> {
  items?: T[];
  count?: number;
  tileSize?: number;
  roundness?: number;
  zoom?: number;
  pullBack?: number;
  stretch?: number;
  inertia?: number;
  autoplay?: number;
  grayscale?: boolean;
  dim?: number;
  intro?: boolean;
  showInfo?: boolean;
  renderInfo?: (item: T, index: number, moving: boolean) => ReactNode;
  theme?: "dark" | "light";
  accentColor?: string;
  backgroundColor?: string;
  onActiveChange?: (item: T, index: number) => void;
  onItemClick?: (item: T, index: number) => void;
  className?: string;
  style?: CSSProperties;
}

declare function InfiniteMenu<T extends InfiniteMenuItem = InfiniteMenuItem>(props: InfiniteMenuProps<T>): ReactElement;
export default InfiniteMenu;
