import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Props = {
  stickerImage: string;
  stickerName: string;
  backgroundColor: string;
};

export const StickerReveal: React.FC<Props> = ({
  stickerImage,
  stickerName,
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Peel-off reveal effect
  const revealProgress = spring({
    frame,
    fps,
    config: { damping: 15, mass: 1.2 },
  });

  const rotation = interpolate(revealProgress, [0, 1], [-15, 0]);
  const stickerScale = interpolate(revealProgress, [0, 0.5, 1], [0.3, 1.1, 1]);
  const shadowBlur = interpolate(revealProgress, [0, 0.5, 1], [0, 30, 10]);

  // Name label
  const labelOpacity = interpolate(frame, [40, 55], [0, 1], {
    extrapolateRight: "clamp",
  });
  const labelY = interpolate(frame, [40, 55], [20, 0], {
    extrapolateRight: "clamp",
  });

  // Sparkle effect
  const sparkles = Array.from({ length: 6 }, (_, i) => {
    const delay = 30 + i * 5;
    const s = spring({ frame: frame - delay, fps, config: { damping: 8 } });
    const angle = (i / 6) * Math.PI * 2;
    const radius = 320;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      scale: Math.max(0, s),
      opacity: interpolate(frame, [delay, delay + 20, delay + 40], [0, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    };
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Sparkles */}
      {sparkles.map((sp, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: "50%",
            top: "45%",
            transform: `translate(${sp.x}px, ${sp.y}px) scale(${sp.scale})`,
            opacity: sp.opacity,
            fontSize: 40,
          }}
        >
          ✦
        </div>
      ))}

      {/* Sticker */}
      <div
        style={{
          transform: `rotate(${rotation}deg) scale(${stickerScale})`,
          filter: `drop-shadow(0 ${shadowBlur}px ${shadowBlur * 1.5}px rgba(0,0,0,0.4))`,
        }}
      >
        {stickerImage ? (
          <Img
            src={stickerImage}
            style={{
              width: 500,
              height: 500,
              objectFit: "contain",
            }}
          />
        ) : (
          <div
            style={{
              width: 500,
              height: 500,
              backgroundColor: "white",
              borderRadius: 30,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              fontSize: 200,
            }}
          >
            ⭐
          </div>
        )}
      </div>

      {/* Label */}
      <div
        style={{
          position: "absolute",
          bottom: 140,
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
          textAlign: "center",
        }}
      >
        <h2
          style={{
            color: "white",
            fontSize: 48,
            fontFamily: "Arial, sans-serif",
            fontWeight: "bold",
            textShadow: "0 2px 15px rgba(0,0,0,0.5)",
            margin: 0,
          }}
        >
          {stickerName}
        </h2>
      </div>
    </AbsoluteFill>
  );
};
