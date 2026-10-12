import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";

// The Butterfly Record mark; the wings beat a fixed number of times from `from`.
export const Mark: React.FC<{
  size: number;
  from?: number;
  beats?: number;
}> = ({ size, from = 0, beats = 2 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const period = Math.round(0.9 * fps);
  const local = frame - from;
  const active = local >= 0 && local < period * beats;
  const phase = active ? (local % period) / period : 0;
  const swing = active
    ? interpolate(Math.sin(phase * Math.PI), [0, 1], [12, 68], {
        easing: Easing.inOut(Easing.sin),
      })
    : 12;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ overflow: "visible", perspective: size * 4 }}
    >
      <g
        style={{
          transformBox: "view-box",
          transformOrigin: "center",
          transform: `rotateY(${swing}deg)`,
        }}
        fill={theme.ink}
      >
        <circle cx="7.2" cy="9" r="4.8" />
        <circle cx="8.2" cy="16" r="3.6" />
      </g>
      <g
        style={{
          transformBox: "view-box",
          transformOrigin: "center",
          transform: `rotateY(${-swing}deg)`,
        }}
      >
        <circle cx="16.8" cy="9" r="4.8" fill={theme.ink} />
        <circle cx="15.8" cy="16" r="3.6" fill={theme.record} />
        <circle
          cx="15.8"
          cy="16"
          r="2.35"
          fill="none"
          stroke={theme.ground}
          strokeWidth="0.62"
        />
      </g>
      <rect x="11.15" y="7.4" width="1.7" height="10" rx="0.85" fill={theme.ink} />
      <path
        d="M11.7 7.6 C11.1 5.8 10 4.6 8.8 3.9"
        fill="none"
        stroke={theme.ink}
        strokeWidth="1"
        strokeLinecap="round"
      />
      <path
        d="M12.3 7.6 C12.9 5.8 14 4.6 15.2 3.9"
        fill="none"
        stroke={theme.ink}
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
};
