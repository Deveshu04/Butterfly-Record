import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { useVideoConfig } from "remotion";
import { Feature } from "./Feature";
import { FADE } from "./theme";
import { Title } from "./Title";

export const Demo: React.FC = () => {
  const { fps } = useVideoConfig();
  const cut = <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />;

  return (
    <TransitionSeries name="Demo">
      <TransitionSeries.Sequence name="Intro" durationInFrames={120} premountFor={fps}>
        <Title heading="Butterfly Record" lines={["A free, open-source screen recorder for Windows"]} />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Record" durationInFrames={240} premountFor={fps}>
        <Feature
          title="Record your screen or one window"
          subtitle="Up to 4K at 60 fps, with your microphone and system audio."
          image="shots/record.png"
          focus={{ x: 0.56, y: 0.42 }}
          zoom={1.15}
          click={{ x: 0.422, y: 0.657, at: 170 }}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Recording bar" durationInFrames={165} premountFor={fps}>
        <Feature
          title="A recording bar that stays out of the video"
          subtitle="Pause, mute, stop or discard from a bar that is never captured."
          image="shots/hud.png"
          focus={{ x: 0.5, y: 0.92 }}
          zoom={1.35}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Library" durationInFrames={195} premountFor={fps}>
        <Feature
          title="Every recording is a file on your disk"
          subtitle="No account, no upload, no time limit, no watermark."
          image="shots/library.png"
          focus={{ x: 0.4, y: 0.2 }}
          zoom={1.3}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="On-device transcript" durationInFrames={255} premountFor={fps}>
        <Feature
          title="Transcribe on your own PC"
          subtitle="Whisper runs on your GPU or CPU. The audio never leaves your machine."
          image="shots/transcript-local.png"
          focus={{ x: 0.86, y: 0.36 }}
          zoom={1.45}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Sarvam transcript" durationInFrames={195} premountFor={fps}>
        <Feature
          title="Or use your own Sarvam key"
          subtitle="Transcripts in English and Indian languages."
          image="shots/transcript-sarvam.png"
          focus={{ x: 0.86, y: 0.33 }}
          zoom={1.45}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Dub" durationInFrames={210} premountFor={fps}>
        <Feature
          title="Translate and dub into Indian languages"
          subtitle="Subtitles in another language, or a dubbed copy of the video."
          image="shots/dub.png"
          focus={{ x: 0.86, y: 0.3 }}
          zoom={1.4}
        />
      </TransitionSeries.Sequence>
      {cut}
      <TransitionSeries.Sequence name="Outro" durationInFrames={180} premountFor={fps}>
        <Title
          heading="Butterfly Record"
          lines={["Free and open source, MIT licence", "github.com/Deveshu04/Butterfly-Record"]}
        />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};

// 1560 frames of scenes, minus seven fades.
export const DEMO_DURATION = 1560 - 7 * FADE;
