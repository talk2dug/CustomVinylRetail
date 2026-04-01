import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { TextOverlay as TextOverlayType } from "../schemas/TikTokSchema";

type Props = Omit<TextOverlayType, "startFrame">;

export const TextOverlay: React.FC<Props> = ({
  text,
  durationFrames,
  position,
  animation,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const positionStyle: React.CSSProperties = {
    top: position === "top" ? "15%" : position === "center" ? "42%" : undefined,
    bottom: position === "bottom" ? "20%" : undefined,
  };

  let animStyle: React.CSSProperties = {};

  if (animation === "fade-in") {
    const opacity = interpolate(frame, [0, 15], [0, 1], {
      extrapolateRight: "clamp",
    });
    animStyle = { opacity };
  } else if (animation === "slide-up") {
    const progress = spring({ frame, fps, durationInFrames: 20 });
    animStyle = {
      opacity: progress,
      transform: `translateY(${interpolate(progress, [0, 1], [40, 0])}px)`,
    };
  } else if (animation === "pop") {
    const scale = spring({ frame, fps, config: { damping: 8, stiffness: 200 } });
    animStyle = { transform: `scale(${scale})` };
  } else if (animation === "typewriter") {
    const charsToShow = Math.floor(
      interpolate(frame, [0, Math.min(text.length * 3, durationFrames * 0.5)], [0, text.length], {
        extrapolateRight: "clamp",
      })
    );
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          ...positionStyle,
        }}
      >
        <div
          style={{
            fontSize: style.fontSize,
            color: style.color,
            backgroundColor: style.backgroundColor || "rgba(0,0,0,0.6)",
            padding: "12px 24px",
            borderRadius: 8,
            fontFamily: "Arial, sans-serif",
            fontWeight: "bold",
            textAlign: "center",
            maxWidth: "80%",
          }}
        >
          {text.slice(0, charsToShow)}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        ...positionStyle,
        ...animStyle,
      }}
    >
      <div
        style={{
          fontSize: style.fontSize,
          color: style.color,
          backgroundColor: style.backgroundColor || "rgba(0,0,0,0.6)",
          padding: "12px 24px",
          borderRadius: 8,
          fontFamily: "Arial, sans-serif",
          fontWeight: "bold",
          textAlign: "center",
          maxWidth: "80%",
        }}
      >
        {text}
      </div>
    </div>
  );
};
