import type { CSSProperties, ReactElement, ReactNode } from "react";

/** Types for the React Bits PixelCard (PixelCard.jsx), from its props table. */
export interface PixelCardProps {
  variant?: "default" | "blue" | "yellow" | "pink";
  colors?: string | string[];
  glowColor?: string;
  gap?: number;
  pixelSize?: number;
  speed?: number;
  shape?: "square" | "circle" | "diamond";
  origin?: "center" | "pointer";
  revealDuration?: number;
  spotlight?: number;
  glow?: number;
  opacity?: number;
  fade?: number;
  trigger?: "hover" | "click" | "always";
  clickPulse?: boolean;
  intro?: boolean;
  introDelay?: number;
  noFocus?: boolean;
  theme?: "dark" | "light";
  radius?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

declare function PixelCard(props: PixelCardProps): ReactElement;
export default PixelCard;
