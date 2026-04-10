import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Props = {
  headline: string;
  subheadline: string;
  productImages: string[];
  accentColor: string;
};

export const TikTokPromo: React.FC<Props> = ({
  headline,
  subheadline,
  productImages,
  accentColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Headline animation
  const headlineScale = spring({ frame, fps, config: { damping: 8, mass: 0.8 } });
  const headlineOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Subheadline
  const subOpacity = interpolate(frame, [30, 50], [0, 1], {
    extrapolateRight: "clamp",
  });
  const subY = interpolate(frame, [30, 50], [30, 0], {
    extrapolateRight: "clamp",
  });

  // Outro fade
  const outroOpacity = interpolate(
    frame,
    [durationInFrames - 30, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)`,
        opacity: outroOpacity,
      }}
    >
      {/* Headline */}
      <div
        style={{
          position: "absolute",
          top: 200,
          width: "100%",
          textAlign: "center",
          opacity: headlineOpacity,
          transform: `scale(${headlineScale})`,
        }}
      >
        <h1
          style={{
            color: "white",
            fontSize: 72,
            fontFamily: "Arial, sans-serif",
            fontWeight: "900",
            margin: 0,
            padding: "0 40px",
          }}
        >
          {headline}
        </h1>
      </div>

      {/* Subheadline */}
      <div
        style={{
          position: "absolute",
          top: 340,
          width: "100%",
          textAlign: "center",
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
        }}
      >
        <p
          style={{
            color: accentColor,
            fontSize: 40,
            fontFamily: "Arial, sans-serif",
            fontWeight: "600",
            margin: 0,
            padding: "0 40px",
          }}
        >
          {subheadline}
        </p>
      </div>

      {/* Product image carousel */}
      {productImages.map((img, i) => (
        <Sequence key={i} from={60 + i * 45} durationInFrames={90}>
          <ProductSlide image={img} index={i} accentColor={accentColor} />
        </Sequence>
      ))}

      {/* Fallback if no images */}
      {productImages.length === 0 && (
        <Sequence from={60} durationInFrames={200}>
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              gap: 30,
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {["🎨", "✂️", "🖨️"].map((emoji, i) => {
              const s = spring({
                frame: frame - 60 - i * 15,
                fps,
                config: { damping: 10 },
              });
              return (
                <div
                  key={i}
                  style={{
                    fontSize: 100,
                    transform: `scale(${Math.max(0, s)})`,
                  }}
                >
                  {emoji}
                </div>
              );
            })}
          </div>
        </Sequence>
      )}

      {/* CTA */}
      <Sequence from={180}>
        <CTA frame={frame - 180} fps={fps} accentColor={accentColor} />
      </Sequence>
    </AbsoluteFill>
  );
};

const ProductSlide: React.FC<{
  image: string;
  index: number;
  accentColor: string;
}> = ({ image, index, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });

  return (
    <div
      style={{
        position: "absolute",
        top: "45%",
        left: "50%",
        transform: `translate(-50%, -50%) scale(${scale})`,
      }}
    >
      <div
        style={{
          border: `4px solid ${accentColor}`,
          borderRadius: 24,
          overflow: "hidden",
          boxShadow: `0 0 40px ${accentColor}40`,
        }}
      >
        <Img
          src={image}
          style={{ width: 700, height: 700, objectFit: "cover" }}
        />
      </div>
    </div>
  );
};

const CTA: React.FC<{ frame: number; fps: number; accentColor: string }> = ({
  frame,
  fps,
  accentColor,
}) => {
  const scale = spring({ frame, fps, config: { damping: 10 } });
  const pulse = Math.sin(frame * 0.1) * 0.03 + 1;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 250,
        width: "100%",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          backgroundColor: accentColor,
          padding: "24px 48px",
          borderRadius: 60,
          transform: `scale(${Math.max(0, scale) * pulse})`,
          boxShadow: `0 8px 30px ${accentColor}60`,
        }}
      >
        <span
          style={{
            color: "white",
            fontSize: 36,
            fontFamily: "Arial, sans-serif",
            fontWeight: "bold",
          }}
        >
          Shop Now →
        </span>
      </div>
    </div>
  );
};
