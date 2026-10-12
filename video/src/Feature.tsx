import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme } from "./theme";

const WINDOW = { left: 240, top: 292, width: 1440, height: 788 };
const SHOT_ASPECT = 10 / 16;

export type Click = {
  /** Position in the screenshot, as fractions of its width and height. */
  x: number;
  y: number;
  /** Frame of the click, relative to the scene. */
  at: number;
};

export const Feature: React.FC<{
  title: string;
  subtitle: string;
  image: string;
  /** Point of the screenshot the camera settles on, as fractions. */
  focus?: { x: number; y: number };
  zoom?: number;
  click?: Click;
}> = ({ title, subtitle, image, focus = { x: 0.5, y: 0.3 }, zoom = 1.25, click }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const push = interpolate(frame, [0.6 * fps, durationInFrames - 0.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.45, 0, 0.2, 1),
  });

  const width = WINDOW.width;
  const height = width * SHOT_ASPECT;
  const scale = 1 + (zoom - 1) * push;
  const fx = focus.x * width;
  const fy = focus.y * height;
  // Move the focus point toward the window centre while zooming, without exposing an edge.
  const px = interpolate(push, [0, 1], [fx, WINDOW.width / 2]);
  const py = interpolate(push, [0, 1], [fy, WINDOW.height / 2]);
  const tx = Math.min(0, Math.max(WINDOW.width - width * scale, px - fx * scale));
  const ty = Math.min(0, Math.max(WINDOW.height - height * scale, py - fy * scale));

  return (
    <AbsoluteFill style={{ backgroundColor: theme.ground, fontFamily: theme.font }}>
      <div
        style={{
          position: "absolute",
          left: 240,
          top: 96,
          width: 1440,
          opacity: enter,
          translate: `0px ${interpolate(enter, [0, 1], [24, 0])}px`,
        }}
      >
        <div
          style={{
            color: theme.ink,
            fontSize: 64,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: theme.muted,
            fontSize: 32,
            fontWeight: 400,
            marginTop: 16,
            lineHeight: 1.3,
          }}
        >
          {subtitle}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: WINDOW.left,
          top: WINDOW.top,
          width: WINDOW.width,
          height: WINDOW.height + 40,
          borderRadius: "14px 14px 0 0",
          border: `1px solid ${theme.hairline}`,
          borderBottom: "none",
          overflow: "hidden",
          backgroundColor: theme.surface,
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
          opacity: enter,
          translate: `0px ${interpolate(enter, [0, 1], [80, 0])}px`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width,
            height,
            transformOrigin: "0 0",
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          }}
        >
          <Img src={staticFile(image)} style={{ width, height, display: "block" }} />
          {click ? <ClickMark click={click} width={width} height={height} scale={scale} /> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const ClickMark: React.FC<{ click: Click; width: number; height: number; scale: number }> = ({
  click,
  width,
  height,
  scale,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const travel = interpolate(frame, [click.at - fps, click.at], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.45, 0, 0.2, 1),
  });
  const x = interpolate(travel, [0, 1], [click.x * width + 220, click.x * width]);
  const y = interpolate(travel, [0, 1], [click.y * height + 140, click.y * height]);
  const ring = interpolate(frame, [click.at, click.at + 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const visible = frame >= click.at - fps;

  return visible ? (
    <>
      <div
        style={{
          position: "absolute",
          left: x - 22,
          top: y - 22,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: `2px solid ${theme.ink}`,
          opacity: ring > 0 && ring < 1 ? 1 - ring : 0,
          scale: String(0.6 + ring * 0.9),
        }}
      />
      <svg
        width={22 / scale}
        height={30 / scale}
        viewBox="0 0 22 30"
        style={{ position: "absolute", left: x, top: y, overflow: "visible" }}
      >
        <path
          d="M1 1 L1 24 L7 18.5 L11 28 L15 26.3 L11 17 L19 17 Z"
          fill="#ffffff"
          stroke="#111111"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </>
  ) : null;
};
