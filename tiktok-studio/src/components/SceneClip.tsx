import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { Transition } from "../schemas/TikTokSchema";

interface SceneClipProps {
  clipFilename: string;
  trimStart: number;
  playbackRate: number;
  transition: Transition;
  isLast: boolean;
}

export const SceneClip: React.FC<SceneClipProps> = ({
  clipFilename,
  trimStart,
  playbackRate,
  transition,
  isLast,
}) => {
  const frame = useCurrentFrame();

  // Fade transition
  let opacity = 1;
  if (transition.type === "fade" && transition.durationFrames > 0) {
    // Fade in at the start
    opacity = interpolate(frame, [0, transition.durationFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  return (
    <AbsoluteFill style={{ opacity }}>
      <OffthreadVideo
        src={staticFile(`footage/${clipFilename}`)}
        startFrom={Math.round(trimStart * 30)}
        playbackRate={playbackRate}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </AbsoluteFill>
  );
};
