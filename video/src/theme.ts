import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

export const FPS = 30;
export const FADE = 15;

export const theme = {
  font: fontFamily,
  ground: "#0f0f0f",
  surface: "#161616",
  ink: "#ededed",
  muted: "#9a9a9a",
  hairline: "rgba(255, 255, 255, 0.14)",
  record: "#FF6B6B",
};
