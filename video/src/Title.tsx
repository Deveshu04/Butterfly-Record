import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Mark } from "./Mark";
import { theme } from "./theme";

// Opening and closing card: the mark, the name and up to two lines below it.
export const Title: React.FC<{
  heading: string;
  lines: string[];
}> = ({ heading, lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = (delay: number) =>
    interpolate(frame, [delay, delay + 0.8 * fps], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.ground,
        fontFamily: theme.font,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ opacity: rise(0), scale: String(interpolate(rise(0), [0, 1], [0.9, 1])) }}>
        <Mark size={168} from={Math.round(0.3 * fps)} />
      </div>
      <div
        style={{
          marginTop: 40,
          color: theme.ink,
          fontSize: 96,
          fontWeight: 600,
          letterSpacing: "-0.025em",
          opacity: rise(0.25 * fps),
          translate: `0px ${interpolate(rise(0.25 * fps), [0, 1], [24, 0])}px`,
        }}
      >
        {heading}
      </div>
      {lines.map((line, index) => (
        <div
          key={line}
          style={{
            marginTop: index === 0 ? 20 : 10,
            color: index === 0 ? theme.ink : theme.muted,
            fontSize: index === 0 ? 40 : 32,
            fontWeight: 400,
            opacity: rise((0.5 + index * 0.2) * fps),
            translate: `0px ${interpolate(rise((0.5 + index * 0.2) * fps), [0, 1], [20, 0])}px`,
          }}
        >
          {line}
        </div>
      ))}
    </AbsoluteFill>
  );
};
