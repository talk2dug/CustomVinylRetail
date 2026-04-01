import React from "react";
import {
  AbsoluteFill,
  Sequence,
  Audio,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { TikTokProps } from "../schemas/TikTokSchema";
import { SceneClip } from "../components/SceneClip";
import { TextOverlay } from "../components/TextOverlay";
import { BrandWatermark } from "../components/BrandWatermark";

export const TikTokVideo: React.FC<TikTokProps> = ({
  scenes,
  transitions,
  textOverlays,
  musicTrack,
  musicVolume,
  brandWatermark,
}) => {
  // Calculate scene start frames (accounting for transitions)
  let currentFrame = 0;
  const sceneTimings: { startFrame: number; durationFrames: number }[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipDuration = (scene.trimEnd - scene.trimStart) / scene.playbackRate;
    const durationFrames = Math.round(clipDuration * 30);

    sceneTimings.push({ startFrame: currentFrame, durationFrames });

    // Subtract transition overlap for next scene
    const transition = transitions[i];
    if (transition && transition.type !== "cut" && i < scenes.length - 1) {
      currentFrame += durationFrames - transition.durationFrames;
    } else {
      currentFrame += durationFrames;
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Scene clips */}
      {scenes.map((scene, i) => {
        const timing = sceneTimings[i];
        if (!timing) return null;
        return (
          <Sequence
            key={i}
            from={timing.startFrame}
            durationInFrames={timing.durationFrames}
          >
            <SceneClip
              clipFilename={scene.clipFilename}
              trimStart={scene.trimStart}
              playbackRate={scene.playbackRate}
              transition={transitions[i] || { type: "cut", durationFrames: 0 }}
              isLast={i === scenes.length - 1}
            />
          </Sequence>
        );
      })}

      {/* Text overlays */}
      {textOverlays.map((overlay, i) => (
        <Sequence
          key={`text-${i}`}
          from={overlay.startFrame}
          durationInFrames={overlay.durationFrames}
        >
          <TextOverlay {...overlay} />
        </Sequence>
      ))}

      {/* Brand watermark */}
      {brandWatermark && <BrandWatermark />}

      {/* Background music */}
      {musicTrack && (
        <Audio
          src={staticFile(`music/${musicTrack}`)}
          volume={musicVolume}
          startFrom={0}
        />
      )}
    </AbsoluteFill>
  );
};
