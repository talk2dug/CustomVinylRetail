import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  spring,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const mockupReelSchema = z.object({
  /** Filter: mockup source */
  source: z.enum(["all", "apparel", "custom-art"]).default("all"),
  /** Filter: max number of mockups to include */
  limit: z.number().min(1).max(20).default(6),
  /** Hook text shown at start */
  hookText: z.string().default("Check out our latest drops"),
  /** Brand name */
  brandName: z.string().default("BlueRidge Custom Co."),
  /** Location tagline */
  location: z.string().default("Asheville, NC"),
  /** Background color */
  bgColor: z.string().default("#111111"),
  /** Accent color */
  accent: z.string().default("#ff6b35"),
  /** Transition style */
  transition: z.enum(["slide", "zoom", "fade"]).default("zoom"),
  /** How images fill the frame and move */
  panMode: z
    .enum([
      "fit",
      "cover-static",
      "ken-burns",
      "pan-left-right",
      "pan-right-left",
      "pan-top-bottom",
      "pan-bottom-top",
    ])
    .default("ken-burns"),
  /** Optional voiceover/music URL */
  audioUrl: z.string().default(""),
  /** Audio volume (0-1) */
  audioVolume: z.number().min(0).max(1).default(1),
  /** Auto-populated: mockup image URLs (from calculateMetadata) */
  mockupImages: z.array(z.string()).default([]),
  /** Auto-populated: labels for each mockup */
  labels: z.array(z.string()).default([]),
});

type Props = z.infer<typeof mockupReelSchema>;

export const MockupReel: React.FC<Props> = ({
  mockupImages = [],
  labels = [],
  hookText,
  brandName,
  location,
  bgColor,
  accent,
  transition,
  panMode = "ken-burns",
  audioUrl = "",
  audioVolume = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const count = mockupImages.length || 1;

  // Hook text animation (first 60 frames)
  const hookScale = spring({ frame, fps, config: { damping: 8, mass: 0.6 } });
  const hookExit = interpolate(frame, [50, 65], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Each mockup duration
  const mockupStart = 70;
  const mockupArea = durationInFrames - mockupStart - 45;
  const perMockup = Math.max(40, Math.floor(mockupArea / count));

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      {audioUrl && <Audio src={audioUrl} volume={audioVolume} />}
      {/* Hook text */}
      <Sequence durationInFrames={70}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            opacity: hookExit,
          }}
        >
          <div style={{ transform: `scale(${hookScale})`, textAlign: "center", padding: "0 60px" }}>
            <h1
              style={{
                color: "white",
                fontSize: 64,
                fontFamily: "Arial, sans-serif",
                fontWeight: 900,
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              {hookText}
            </h1>
            <div
              style={{
                marginTop: 20,
                height: 4,
                width: 120,
                backgroundColor: accent,
                borderRadius: 2,
                margin: "20px auto 0",
              }}
            />
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Mockup slides */}
      {mockupImages.map((img, i) => (
        <Sequence
          key={i}
          from={mockupStart + i * perMockup}
          durationInFrames={perMockup + 10}
        >
          <MockupSlide
            image={img}
            label={labels[i] || ""}
            accent={accent}
            transition={transition}
            panMode={panMode}
            slideFrames={perMockup + 10}
            bgColor={bgColor}
            index={i}
            total={count}
          />
        </Sequence>
      ))}

      {/* End card */}
      <Sequence from={durationInFrames - 45}>
        <EndCard brandName={brandName} location={location} accent={accent} />
      </Sequence>
    </AbsoluteFill>
  );
};

const MockupSlide: React.FC<{
  image: string;
  label: string;
  accent: string;
  transition: string;
  panMode: string;
  slideFrames: number;
  bgColor: string;
  index: number;
  total: number;
}> = ({
  image,
  label,
  accent,
  transition,
  panMode,
  slideFrames,
  bgColor,
  index,
  total,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // ── Entry transition (applied to the whole slide container) ──
  const enterSpring = spring({ frame, fps, config: { damping: 14 } });
  let containerTransform = "";
  let containerOpacity = 1;

  if (transition === "zoom") {
    containerOpacity = interpolate(frame, [0, 8], [0, 1], {
      extrapolateRight: "clamp",
    });
  } else if (transition === "slide") {
    const x = interpolate(enterSpring, [0, 1], [width, 0]);
    containerTransform = `translateX(${x}px)`;
  } else {
    containerOpacity = interpolate(frame, [0, 12], [0, 1], {
      extrapolateRight: "clamp",
    });
  }

  // ── Pan/zoom effect for the image itself ──
  // Progress 0 → 1 over the whole slide
  const progress = Math.min(frame / Math.max(slideFrames - 10, 1), 1);

  let imgStyle: React.CSSProperties = {};

  if (panMode === "fit") {
    // Show entire image, letterboxed/pillarboxed against bgColor
    imgStyle = {
      width: "100%",
      height: "100%",
      objectFit: "contain",
    };
  } else if (panMode === "cover-static") {
    // Current behavior: crop to fill, no movement
    imgStyle = {
      width: "100%",
      height: "100%",
      objectFit: "cover",
    };
  } else if (panMode === "ken-burns") {
    // Gentle zoom + slight diagonal pan
    const scale = interpolate(progress, [0, 1], [1.05, 1.18]);
    const tx = interpolate(progress, [0, 1], [0, -30]);
    const ty = interpolate(progress, [0, 1], [0, -20]);
    imgStyle = {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
      transformOrigin: "center",
    };
  } else if (panMode === "pan-left-right" || panMode === "pan-right-left") {
    // Image fits vertically, overflows horizontally, pans
    const scale = 1.35; // overflow to allow pan
    const maxPan = width * 0.18;
    const tx =
      panMode === "pan-left-right"
        ? interpolate(progress, [0, 1], [-maxPan, maxPan])
        : interpolate(progress, [0, 1], [maxPan, -maxPan]);
    imgStyle = {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      transform: `scale(${scale}) translateX(${tx}px)`,
      transformOrigin: "center",
    };
  } else if (panMode === "pan-top-bottom" || panMode === "pan-bottom-top") {
    const scale = 1.35;
    const maxPan = height * 0.1;
    const ty =
      panMode === "pan-top-bottom"
        ? interpolate(progress, [0, 1], [-maxPan, maxPan])
        : interpolate(progress, [0, 1], [maxPan, -maxPan]);
    imgStyle = {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      transform: `scale(${scale}) translateY(${ty}px)`,
      transformOrigin: "center",
    };
  }

  const labelOpacity = interpolate(frame, [10, 20], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          transform: containerTransform,
          opacity: containerOpacity,
          overflow: "hidden",
        }}
      >
        <Img src={image} style={imgStyle} />
        {/* Dark gradient at bottom */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 300,
            background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Label */}
      {label && (
        <div
          style={{
            position: "absolute",
            bottom: 120,
            width: "100%",
            textAlign: "center",
            opacity: labelOpacity,
          }}
        >
          <span
            style={{
              color: "white",
              fontSize: 36,
              fontFamily: "Arial, sans-serif",
              fontWeight: 700,
              textShadow: "0 2px 15px rgba(0,0,0,0.6)",
            }}
          >
            {label}
          </span>
        </div>
      )}

      {/* Counter */}
      {total > 1 && (
        <div
          style={{
            position: "absolute",
            top: 40,
            right: 40,
            backgroundColor: "rgba(0,0,0,0.5)",
            padding: "8px 16px",
            borderRadius: 20,
          }}
        >
          <span style={{ color: "white", fontSize: 22, fontFamily: "Arial" }}>
            {index + 1}/{total}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const EndCard: React.FC<{
  brandName: string;
  location: string;
  accent: string;
}> = ({ brandName, location, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 10 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "rgba(0,0,0,0.85)",
        justifyContent: "center",
        alignItems: "center",
        transform: `scale(${scale})`,
      }}
    >
      <h2
        style={{
          color: "white",
          fontSize: 56,
          fontFamily: "Arial, sans-serif",
          fontWeight: 900,
          margin: 0,
        }}
      >
        {brandName}
      </h2>
      <div
        style={{
          width: 80,
          height: 4,
          backgroundColor: accent,
          borderRadius: 2,
          margin: "16px 0",
        }}
      />
      <p
        style={{
          color: accent,
          fontSize: 30,
          fontFamily: "Arial, sans-serif",
          fontWeight: 600,
          margin: 0,
        }}
      >
        {location}
      </p>
    </AbsoluteFill>
  );
};
