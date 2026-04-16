import {
  AbsoluteFill,
  Audio,
  Img,
  Video,
  interpolate,
  spring,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const metalPrintStorySchema = z.object({
  // ── Copy ──────────────────────────────────────────────
  hook: z.string().default("Hand-finished metal prints"),
  processIntro: z.string().default("Watch it come to life"),
  artExplainer: z.string().default("Every detail pressed into metal.\nMade to live in the light."),
  whyMetal: z
    .string()
    .default("Museum-grade metal catches light and color that paper cannot."),
  ctaText: z.string().default("Shop Now"),
  outro: z.string().default("Asheville, NC Studio"),
  brandName: z.string().default("BlueRidge Custom Co."),
  // ── Media ─────────────────────────────────────────────
  /** Process clips (footage library videos) */
  processClips: z
    .array(
      z.object({
        url: z.string(),
        durationInFrames: z.number().default(75),
      })
    )
    .default([]),
  /** Lifestyle mockup images (art in context: garages, offices, etc.) */
  mockupImages: z.array(z.string()).default([]),
  /** Hero/finished art image (optional — used for reveal shot) */
  heroImage: z.string().default(""),
  // ── Theme ─────────────────────────────────────────────
  bgColor: z.string().default("#0a0a0a"),
  accent: z.string().default("#c9a048"), // warm gold accent for metal feel
  /** Transition style for image scenes */
  transition: z.enum(["slide", "zoom", "fade"]).default("zoom"),
  /** Optional voiceover or music */
  audioUrl: z.string().default(""),
  audioVolume: z.number().min(0).max(1).default(1),
  /** CTA URL displayed as a pill banner */
  ctaUrl: z.string().default(""),
});

type Props = z.infer<typeof metalPrintStorySchema>;

// Durations in frames (@ 30fps)
const HOOK_FRAMES = 75; // 2.5s
const PROCESS_INTRO_FRAMES = 45; // 1.5s
const HERO_FRAMES = 90; // 3s
const ART_EXPLAINER_FRAMES = 75; // 2.5s
const MOCKUP_FRAMES_EACH = 90; // 3s
const WHY_METAL_FRAMES = 90; // 3s
const OUTRO_FRAMES = 90; // 3s

export const MetalPrintStory: React.FC<Props> = ({
  hook,
  processIntro,
  artExplainer,
  whyMetal,
  ctaText,
  outro,
  brandName,
  processClips = [],
  mockupImages = [],
  heroImage = "",
  bgColor,
  accent,
  audioUrl = "",
  audioVolume = 1,
  ctaUrl = "",
  transition = "zoom",
}) => {
  // Compute scene starts
  let cursor = 0;
  const sHook = cursor;
  cursor += HOOK_FRAMES;
  const sProcessIntro = cursor;
  cursor += PROCESS_INTRO_FRAMES;
  const processStart = cursor;
  const processFramesTotal = processClips.reduce(
    (sum, c) => sum + (c.durationInFrames || MOCKUP_FRAMES_EACH),
    0
  );
  cursor += processFramesTotal;
  const sHero = cursor;
  cursor += HERO_FRAMES;
  const sArtExplainer = cursor;
  cursor += ART_EXPLAINER_FRAMES;
  const mockupStart = cursor;
  const mockupFramesTotal = mockupImages.length * MOCKUP_FRAMES_EACH;
  cursor += mockupFramesTotal;
  const sWhyMetal = cursor;
  cursor += WHY_METAL_FRAMES;
  const sOutro = cursor;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      {audioUrl && <Audio src={audioUrl} volume={audioVolume} />}

      {/* Subtle gold vignette texture throughout */}
      <Vignette accent={accent} />

      {/* 1. HOOK */}
      <Sequence from={sHook} durationInFrames={HOOK_FRAMES}>
        <HookCard text={hook} accent={accent} />
      </Sequence>

      {/* 2. PROCESS INTRO */}
      <Sequence from={sProcessIntro} durationInFrames={PROCESS_INTRO_FRAMES}>
        <ProcessIntroCard text={processIntro} accent={accent} />
      </Sequence>

      {/* 3. PROCESS CLIPS */}
      {processClips.map((clip, i) => {
        const clipStart = processStart + processClips
          .slice(0, i)
          .reduce((sum, c) => sum + (c.durationInFrames || MOCKUP_FRAMES_EACH), 0);
        return (
          <Sequence
            key={`p-${i}`}
            from={clipStart}
            durationInFrames={clip.durationInFrames || MOCKUP_FRAMES_EACH}
          >
            <ProcessClip url={clip.url} accent={accent} index={i} total={processClips.length} />
          </Sequence>
        );
      })}

      {/* 4. HERO REVEAL */}
      {heroImage && (
        <Sequence from={sHero} durationInFrames={HERO_FRAMES}>
          <HeroReveal image={heroImage} accent={accent} transition={transition} />
        </Sequence>
      )}

      {/* 5. ART EXPLAINER */}
      <Sequence from={sArtExplainer} durationInFrames={ART_EXPLAINER_FRAMES}>
        <ArtExplainerCard text={artExplainer} accent={accent} />
      </Sequence>

      {/* 6. MOCKUPS (art in context) */}
      {mockupImages.map((img, i) => (
        <Sequence
          key={`m-${i}`}
          from={mockupStart + i * MOCKUP_FRAMES_EACH}
          durationInFrames={MOCKUP_FRAMES_EACH}
        >
          <MockupContext image={img} accent={accent} index={i} total={mockupImages.length} transition={transition} />
        </Sequence>
      ))}

      {/* 7. WHY METAL */}
      <Sequence from={sWhyMetal} durationInFrames={WHY_METAL_FRAMES}>
        <WhyMetalCard text={whyMetal} accent={accent} />
      </Sequence>

      {/* 8. OUTRO with CTA */}
      <Sequence from={sOutro} durationInFrames={OUTRO_FRAMES}>
        <OutroCard
          brandName={brandName}
          outro={outro}
          ctaText={ctaText}
          ctaUrl={ctaUrl}
          accent={accent}
        />
      </Sequence>
    </AbsoluteFill>
  );
};

// ─── Components ────────────────────────────────────────────────────────────

const Vignette: React.FC<{ accent: string }> = ({ accent }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%)`,
      pointerEvents: "none",
    }}
  />
);

const HookCard: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 10, mass: 0.8 } });
  const fade = interpolate(frame, [60, 75], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: fade }}>
      <div style={{ transform: `scale(${scale})`, textAlign: "center", padding: "0 60px" }}>
        <div
          style={{
            color: accent,
            fontSize: 22,
            letterSpacing: 6,
            textTransform: "uppercase",
            fontFamily: "Georgia, serif",
            marginBottom: 20,
            opacity: 0.7,
          }}
        >
          — A Metal Story —
        </div>
        <h1
          style={{
            color: "white",
            fontSize: 72,
            fontFamily: "Georgia, serif",
            fontWeight: 700,
            fontStyle: "italic",
            lineHeight: 1.15,
            margin: 0,
            textShadow: `0 2px 30px rgba(0,0,0,0.8)`,
          }}
        >
          {text}
        </h1>
        <div
          style={{
            width: 80,
            height: 2,
            backgroundColor: accent,
            margin: "30px auto 0",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const ProcessIntroCard: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12, 30, 45], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            color: accent,
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontFamily: "Georgia, serif",
            marginBottom: 12,
          }}
        >
          Chapter 01
        </div>
        <h2
          style={{
            color: "white",
            fontSize: 54,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            margin: 0,
          }}
        >
          {text}
        </h2>
      </div>
    </AbsoluteFill>
  );
};

const ProcessClip: React.FC<{
  url: string;
  accent: string;
  index: number;
  total: number;
}> = ({ url, accent, index, total }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, 60], [1, 1.04]);
  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${scale})`,
        }}
      >
        <Video
          src={url}
          muted
          volume={0}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
      {/* Cinematic letterbox bars */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 120, background: "linear-gradient(rgba(0,0,0,0.7), transparent)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 180, background: "linear-gradient(transparent, rgba(0,0,0,0.85))", pointerEvents: "none" }} />
      {/* Step indicator */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          textAlign: "center",
          color: accent,
          fontSize: 18,
          letterSpacing: 4,
          fontFamily: "Georgia, serif",
          textTransform: "uppercase",
          opacity: 0.9,
        }}
      >
        {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </div>
    </AbsoluteFill>
  );
};

const HeroReveal: React.FC<{ image: string; accent: string; transition?: string }> = ({ image, accent, transition = "zoom" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lineWidth = spring({ frame: frame - 30, fps, config: { damping: 14 } });

  // Transition-dependent effects
  let imgScale = 1;
  let imgOpacity = 1;
  let imgTranslateX = 0;

  if (transition === "zoom") {
    imgScale = interpolate(frame, [0, 90], [1.2, 1]);
    imgOpacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  } else if (transition === "fade") {
    imgOpacity = interpolate(frame, [0, 20, 70, 90], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (transition === "slide") {
    imgTranslateX = interpolate(frame, [0, 20], [300, 0], { extrapolateRight: "clamp" });
    imgOpacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Img
        src={image}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
          opacity: imgOpacity,
        }}
      />
      {/* Gold glow frame */}
      <div
        style={{
          position: "absolute",
          inset: 30,
          border: `2px solid ${accent}`,
          opacity: 0.4 * lineWidth,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

const ArtExplainerCard: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 12, 60, 75], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [0, 25], [30, 0], { extrapolateRight: "clamp" });
  const lines = text.split("\n");
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <div style={{ textAlign: "center", padding: "0 60px" }}>
        {lines.map((line, i) => (
          <h2
            key={i}
            style={{
              color: "white",
              fontSize: 42,
              fontFamily: "Georgia, serif",
              fontStyle: "italic",
              fontWeight: 400,
              margin: "8px 0",
              lineHeight: 1.3,
            }}
          >
            {line}
          </h2>
        ))}
        <div
          style={{
            width: 60,
            height: 2,
            backgroundColor: accent,
            margin: "24px auto 0",
            opacity: 0.8,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const MockupContext: React.FC<{
  image: string;
  accent: string;
  index: number;
  total: number;
  transition?: string;
}> = ({ image, accent, index, total, transition = "zoom" }) => {
  const frame = useCurrentFrame();

  // Transition-dependent effects
  let imgScale = 1;
  let imgTranslateX = 0;
  let containerOpacity: number;

  if (transition === "zoom") {
    // Ken Burns-style slow zoom
    imgScale = interpolate(frame, [0, MOCKUP_FRAMES_EACH], [1, 1.06]);
    containerOpacity = interpolate(frame, [0, 10, MOCKUP_FRAMES_EACH - 10, MOCKUP_FRAMES_EACH], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (transition === "fade") {
    containerOpacity = interpolate(frame, [0, 15, MOCKUP_FRAMES_EACH - 15, MOCKUP_FRAMES_EACH], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else {
    // slide
    imgTranslateX = interpolate(frame, [0, 15], [400, 0], { extrapolateRight: "clamp" });
    containerOpacity = interpolate(frame, [0, 10, MOCKUP_FRAMES_EACH - 10, MOCKUP_FRAMES_EACH], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  return (
    <AbsoluteFill style={{ opacity: containerOpacity }}>
      <Img
        src={image}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${imgScale}) translateX(${imgTranslateX}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 250,
          background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
          pointerEvents: "none",
        }}
      />
      {/* Scene label */}
      <div
        style={{
          position: "absolute",
          bottom: 100,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-block",
            padding: "10px 24px",
            border: `1px solid ${accent}`,
            borderRadius: 2,
          }}
        >
          <span
            style={{
              color: accent,
              fontSize: 18,
              letterSpacing: 4,
              fontFamily: "Georgia, serif",
              textTransform: "uppercase",
            }}
          >
            In Situ · {String(index + 1).padStart(2, "0")}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const WhyMetalCard: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 15, 75, 90], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "rgba(0,0,0,0.93)",
        justifyContent: "center",
        alignItems: "center",
        opacity,
      }}
    >
      <div style={{ transform: `scale(${scale})`, textAlign: "center", padding: "0 80px" }}>
        <div
          style={{
            color: accent,
            fontSize: 22,
            letterSpacing: 6,
            textTransform: "uppercase",
            fontFamily: "Georgia, serif",
            marginBottom: 30,
          }}
        >
          Why Metal
        </div>
        <p
          style={{
            color: "white",
            fontSize: 40,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            lineHeight: 1.35,
            margin: 0,
            textShadow: "0 2px 20px rgba(0,0,0,0.8)",
          }}
        >
          {text}
        </p>
        <div
          style={{
            width: 60,
            height: 2,
            backgroundColor: accent,
            margin: "30px auto 0",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const OutroCard: React.FC<{
  brandName: string;
  outro: string;
  ctaText: string;
  ctaUrl: string;
  accent: string;
}> = ({ brandName, outro, ctaText, ctaUrl, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 10 } });
  const displayUrl = ctaUrl.replace(/^https?:\/\//, "");
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0a0a0a",
        justifyContent: "center",
        alignItems: "center",
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          color: accent,
          fontSize: 22,
          letterSpacing: 6,
          textTransform: "uppercase",
          fontFamily: "Georgia, serif",
          marginBottom: 16,
          opacity: 0.8,
        }}
      >
        {brandName}
      </div>
      <h2
        style={{
          color: "white",
          fontSize: 58,
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
          margin: 0,
        }}
      >
        {outro}
      </h2>
      <div
        style={{
          width: 80,
          height: 2,
          backgroundColor: accent,
          margin: "30px 0",
        }}
      />
      {ctaUrl ? (
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: 18,
              letterSpacing: 3,
              textTransform: "uppercase",
              fontFamily: "Georgia, serif",
              marginBottom: 8,
            }}
          >
            {ctaText}
          </div>
          <div
            style={{
              color: accent,
              fontSize: 30,
              fontFamily: "Georgia, serif",
              fontWeight: 700,
            }}
          >
            {displayUrl}
          </div>
        </div>
      ) : (
        <div
          style={{
            color: accent,
            fontSize: 28,
            fontFamily: "Georgia, serif",
            letterSpacing: 2,
          }}
        >
          {ctaText}
        </div>
      )}
    </AbsoluteFill>
  );
};
