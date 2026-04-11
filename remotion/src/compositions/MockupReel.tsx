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
  /** Additional zoom multiplier on top of pan mode (1.0 = no extra zoom) */
  imageScale: z.number().min(0.5).max(3).default(1),
  /** Horizontal offset as percentage of frame width (-50 to 50) */
  imageOffsetX: z.number().min(-50).max(50).default(0),
  /** Vertical offset as percentage of frame height (-50 to 50) */
  imageOffsetY: z.number().min(-50).max(50).default(0),
  /** Pan distance as percentage of frame (how far to pan) */
  panDistance: z.number().min(0).max(100).default(30),
  /** How long each mockup is displayed, in seconds */
  slideSeconds: z.number().min(0.5).max(10).default(2.5),
  /** Pan speed multiplier (1.0 = pan completes over full slide duration) */
  panSpeed: z.number().min(0.25).max(4).default(1),
  /** Optional voiceover/music URL */
  audioUrl: z.string().default(""),
  /** Audio volume (0-1) */
  audioVolume: z.number().min(0).max(1).default(1),
  /** Optional CTA URL displayed as a banner at the bottom of slides */
  ctaUrl: z.string().default(""),
  /** CTA banner label text (e.g. "Shop Now:") */
  ctaLabel: z.string().default("Shop Now:"),
  /** Auto-populated: mockup image URLs (from calculateMetadata) */
  mockupImages: z.array(z.string()).default([]),
  /** Auto-populated: labels for each mockup */
  labels: z.array(z.string()).default([]),
  /** Optional per-item effect overrides (parallel to mockupImages) */
  itemEffects: z
    .array(
      z.object({
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
          .optional(),
        imageScale: z.number().optional(),
        imageOffsetX: z.number().optional(),
        imageOffsetY: z.number().optional(),
        panDistance: z.number().optional(),
        panSpeed: z.number().optional(),
        slideSeconds: z.number().optional(),
      })
    )
    .default([]),
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
  imageScale = 1,
  imageOffsetX = 0,
  imageOffsetY = 0,
  panDistance = 30,
  slideSeconds = 2.5,
  panSpeed = 1,
  itemEffects = [],
  audioUrl = "",
  audioVolume = 1,
  ctaUrl = "",
  ctaLabel = "Shop Now:",
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

  // Each mockup duration — per-item slideSeconds if provided, else global
  const mockupStart = 70;
  const slideFrameCounts = mockupImages.map((_, i) => {
    const itemSeconds = itemEffects[i]?.slideSeconds ?? slideSeconds;
    return Math.max(15, Math.floor(itemSeconds * fps));
  });
  // Cumulative start frames for each slide
  const slideStarts = slideFrameCounts.map((_, i) =>
    mockupStart + slideFrameCounts.slice(0, i).reduce((a, b) => a + b, 0)
  );

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
      {mockupImages.map((img, i) => {
        const eff = itemEffects[i] || {};
        const slideFrames = slideFrameCounts[i];
        return (
          <Sequence
            key={i}
            from={slideStarts[i]}
            durationInFrames={slideFrames + 10}
          >
            <MockupSlide
              image={img}
              label={labels[i] || ""}
              accent={accent}
              transition={transition}
              panMode={eff.panMode ?? panMode}
              imageScale={eff.imageScale ?? imageScale}
              imageOffsetX={eff.imageOffsetX ?? imageOffsetX}
              imageOffsetY={eff.imageOffsetY ?? imageOffsetY}
              panDistance={eff.panDistance ?? panDistance}
              panSpeed={eff.panSpeed ?? panSpeed}
              slideFrames={slideFrames + 10}
              bgColor={bgColor}
              index={i}
              total={count}
            />
          </Sequence>
        );
      })}

      {/* CTA URL banner — appears after hook, stays until outro */}
      {ctaUrl && (
        <Sequence from={mockupStart} durationInFrames={durationInFrames - mockupStart - 45}>
          <CTABanner url={ctaUrl} label={ctaLabel} accent={accent} />
        </Sequence>
      )}

      {/* End card */}
      <Sequence from={durationInFrames - 45}>
        <EndCard brandName={brandName} location={location} accent={accent} ctaUrl={ctaUrl} ctaLabel={ctaLabel} />
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
  imageScale: number;
  imageOffsetX: number;
  imageOffsetY: number;
  panDistance: number;
  panSpeed: number;
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
  imageScale,
  imageOffsetX,
  imageOffsetY,
  panDistance,
  panSpeed,
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

  // ── Pan/zoom effect ──
  // progress: 0 → 1, scaled by panSpeed (higher = faster pan)
  const rawProgress = frame / Math.max(slideFrames - 10, 1);
  const progress = Math.max(0, Math.min(rawProgress * panSpeed, 1));

  // Pan distance in pixels (based on frame dimensions)
  const panPixelsX = (width * panDistance) / 100;
  const panPixelsY = (height * panDistance) / 100;

  // User-set offset in pixels
  const userOffsetX = (width * imageOffsetX) / 100;
  const userOffsetY = (height * imageOffsetY) / 100;

  // Image sizing — no forced scale, just the user's imageScale multiplier.
  // The pan modes choose whether to fit width or height to the frame.
  let imgStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    // centering + user offset + pan animation
  };

  // Additional pan translate
  let panTx = 0;
  let panTy = 0;
  let extraScale = imageScale;

  if (panMode === "fit") {
    // Whole image visible (contain)
    imgStyle = {
      ...imgStyle,
      maxWidth: `${100 * imageScale}%`,
      maxHeight: `${100 * imageScale}%`,
      width: "auto",
      height: "auto",
    };
  } else if (panMode === "cover-static") {
    // Fill frame (may crop)
    imgStyle = {
      ...imgStyle,
      minWidth: `${100 * imageScale}%`,
      minHeight: `${100 * imageScale}%`,
      width: "auto",
      height: "auto",
    };
  } else if (panMode === "ken-burns") {
    // Fill frame with slow zoom in
    const kbScale = interpolate(progress, [0, 1], [1, 1.15]) * imageScale;
    extraScale = kbScale;
    panTx = interpolate(progress, [0, 1], [0, -width * 0.03]);
    panTy = interpolate(progress, [0, 1], [0, -height * 0.02]);
    imgStyle = {
      ...imgStyle,
      minWidth: "100%",
      minHeight: "100%",
      width: "auto",
      height: "auto",
    };
  } else if (panMode === "pan-left-right" || panMode === "pan-right-left") {
    // Fit image HEIGHT to frame; width overflows naturally for wide images.
    // Pan translates horizontally.
    const from = panMode === "pan-left-right" ? -panPixelsX : panPixelsX;
    const to = panMode === "pan-left-right" ? panPixelsX : -panPixelsX;
    panTx = interpolate(progress, [0, 1], [from, to]);
    imgStyle = {
      ...imgStyle,
      height: "100%",
      width: "auto",
    };
  } else if (panMode === "pan-top-bottom" || panMode === "pan-bottom-top") {
    // Fit image WIDTH to frame; height overflows naturally for tall images.
    // Pan translates vertically.
    const from = panMode === "pan-top-bottom" ? -panPixelsY : panPixelsY;
    const to = panMode === "pan-top-bottom" ? panPixelsY : -panPixelsY;
    panTy = interpolate(progress, [0, 1], [from, to]);
    imgStyle = {
      ...imgStyle,
      width: "100%",
      height: "auto",
    };
  }

  // Compose the transform: center image + apply offsets + pan + scale
  const totalTx = userOffsetX + panTx;
  const totalTy = userOffsetY + panTy;
  imgStyle.transform = `translate(calc(-50% + ${totalTx}px), calc(-50% + ${totalTy}px)) scale(${extraScale})`;
  imgStyle.transformOrigin = "center";

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
  ctaUrl?: string;
  ctaLabel?: string;
}> = ({ brandName, location, accent, ctaUrl = "", ctaLabel = "Shop Now:" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 10 } });

  // Strip protocol from URL for display
  const displayUrl = ctaUrl.replace(/^https?:\/\//, "");

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "rgba(0,0,0,0.9)",
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
      {ctaUrl && (
        <div
          style={{
            marginTop: 40,
            padding: "18px 40px",
            backgroundColor: accent,
            borderRadius: 50,
            boxShadow: `0 8px 30px ${accent}60`,
          }}
        >
          <div
            style={{
              color: "white",
              fontSize: 20,
              fontFamily: "Arial, sans-serif",
              fontWeight: 600,
              opacity: 0.8,
              marginBottom: 4,
            }}
          >
            {ctaLabel}
          </div>
          <div
            style={{
              color: "white",
              fontSize: 34,
              fontFamily: "Arial, sans-serif",
              fontWeight: 800,
              letterSpacing: 0.5,
            }}
          >
            {displayUrl}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

const CTABanner: React.FC<{
  url: string;
  label: string;
  accent: string;
}> = ({ url, label, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enterSpring = spring({ frame, fps, config: { damping: 12 } });
  const ty = interpolate(enterSpring, [0, 1], [80, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  // Subtle pulse
  const pulse = 1 + Math.sin(frame * 0.06) * 0.015;
  const displayUrl = url.replace(/^https?:\/\//, "");

  return (
    <div
      style={{
        position: "absolute",
        bottom: 60,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        transform: `translateY(${ty}px) scale(${pulse})`,
        opacity,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          padding: "14px 32px",
          backgroundColor: accent,
          borderRadius: 40,
          boxShadow: `0 8px 30px ${accent}80`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            color: "white",
            fontSize: 22,
            fontFamily: "Arial, sans-serif",
            fontWeight: 700,
            opacity: 0.9,
          }}
        >
          {label}
        </span>
        <span
          style={{
            color: "white",
            fontSize: 26,
            fontFamily: "Arial, sans-serif",
            fontWeight: 900,
          }}
        >
          {displayUrl}
        </span>
      </div>
    </div>
  );
};
