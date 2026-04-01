import React from "react";
import { useCurrentFrame, interpolate } from "remotion";

interface CaptionOverlayProps {
  words: string[];
  wordsPerSecond?: number;
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  words,
  wordsPerSecond = 3,
}) => {
  const frame = useCurrentFrame();
  const framesPerWord = Math.round(30 / wordsPerSecond);
  const currentWordIndex = Math.floor(frame / framesPerWord);

  if (currentWordIndex >= words.length) return null;

  const withinWord = frame % framesPerWord;
  const scale = interpolate(withinWord, [0, 4], [1.15, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        bottom: "25%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontSize: 52,
          color: "#FFFFFF",
          fontWeight: "bold",
          fontFamily: "Arial, sans-serif",
          textShadow: "2px 2px 6px rgba(0,0,0,0.8)",
          transform: `scale(${scale})`,
        }}
      >
        {words[currentWordIndex]}
      </div>
    </div>
  );
};
