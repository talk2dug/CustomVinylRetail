import {
  AbsoluteFill,
  Video,
  Img,
  interpolate,
  spring,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const footageReelSchema = z.object({
  /** Filter: category of footage to pull (leave empty for all) */
  category: z.string().default("timelapse"),
  /** Filter: max number of clips */
  limit: z.number().min(1).max(15).default(5),
  /** Max frames per clip (30fps = 30 frames per second) */
  maxFramesPerClip: z.number().min(30).max(300).default(120),
  /** Hook text shown at start */
  hookText: z.string().default("Behind the scenes"),
  /** Brand tagline at end */
  tagline: z.string().default("Made in Asheville, NC"),
  /** Brand name */
  brandName: z.string().default("BlueRidge Custom Co."),
  /** Background color between clips */
  bgColor: z.string().default("#000000"),
  /** Accent color */
  accent: z.string().default("#ff6b35"),
  /** Show clip labels */
  showLabels: z.boolean().default(true),
  /** Mute video audio */
  muteVideo: z.boolean().default(true),
  /** Auto-populated: clips from calculateMetadata */
  clips: z
    .array(
      z.object({
        url: z.string(),
        type: z.enum(["video", "image"]).default("video"),
        label: z.string().default(""),
        durationInFrames: z.number().default(90),
      })
    )
    .default([]),
});

type Clip = {
  url: string;
  type: "video" | "image";
  label: string;
  durationInFrames: number;
};

type Props = z.infer<typeof footageReelSchema>;

export const FootageReel: React.FC<Props> = ({
  clips = [],
  hookText,
  tagline,
  brandName,
  bgColor,
  accent,
  showLabels,
  muteVideo,
}) => {
  const { durationInFrames } = useVideoConfig();

  // Compute clip start frames
  const hookFrames = 60;
  const outroFrames = 60;
  let cursor = hookFrames;
  const clipSchedule = clips.map((clip) => {
    const start = cursor;
    cursor += clip.durationInFrames;
    return { ...clip, start };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      {/* Hook */}
      <Sequence durationInFrames={hookFrames}>
        <HookCard text={hookText} accent={accent} />
      </Sequence>

      {/* Clips */}
      {clipSchedule.map((clip, i) => (
        <Sequence
          key={i}
          from={clip.start}
          durationInFrames={clip.durationInFrames}
        >
          <ClipCard
            clip={clip}
            accent={accent}
            showLabel={showLabels}
            muteVideo={muteVideo}
            index={i}
            total={clipSchedule.length}
          />
        </Sequence>
      ))}

      {/* Outro */}
      <Sequence from={durationInFrames - outroFrames}>
        <OutroCard brandName={brandName} tagline={tagline} accent={accent} />
      </Sequence>

      {/* Placeholder if empty */}
      {clips.length === 0 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            color: "#666",
            fontSize: 28,
            fontFamily: "Arial, sans-serif",
          }}
        >
          Add clips via the props panel →
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const HookCard: React.FC<{ text: string; accent: string }> = ({
  text,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 8 } });
  const exitOpacity = interpolate(frame, [45, 60], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        opacity: exitOpacity,
      }}
    >
      <div style={{ transform: `scale(${scale})`, textAlign: "center", padding: "0 60px" }}>
        <h1
          style={{
            color: "white",
            fontSize: 80,
            fontFamily: "Arial, sans-serif",
            fontWeight: 900,
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          {text}
        </h1>
        <div
          style={{
            height: 5,
            width: 140,
            backgroundColor: accent,
            borderRadius: 3,
            margin: "24px auto 0",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const ClipCard: React.FC<{
  clip: Clip;
  accent: string;
  showLabel: boolean;
  muteVideo: boolean;
  index: number;
  total: number;
}> = ({ clip, accent, showLabel, muteVideo, index, total }) => {
  const frame = useCurrentFrame();

  const enterOpacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });
  const exitOpacity = interpolate(
    frame,
    [clip.durationInFrames - 8, clip.durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = Math.min(enterOpacity, exitOpacity);

  const labelSlide = interpolate(frame, [8, 20], [60, 0], {
    extrapolateRight: "clamp",
  });
  const labelOpacity = interpolate(frame, [8, 20], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity }}>
      {clip.type === "video" ? (
        <Video
          src={clip.url}
          muted={muteVideo}
          volume={muteVideo ? 0 : 1}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <Img
          src={clip.url}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}

      {/* Bottom gradient overlay */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 400,
          background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
          pointerEvents: "none",
        }}
      />

      {/* Label */}
      {showLabel && clip.label && (
        <div
          style={{
            position: "absolute",
            bottom: 160,
            left: 0,
            right: 0,
            textAlign: "center",
            transform: `translateY(${labelSlide}px)`,
            opacity: labelOpacity,
          }}
        >
          <div
            style={{
              display: "inline-block",
              padding: "12px 32px",
              backgroundColor: accent,
              borderRadius: 40,
            }}
          >
            <span
              style={{
                color: "white",
                fontSize: 32,
                fontFamily: "Arial, sans-serif",
                fontWeight: 700,
              }}
            >
              {clip.label}
            </span>
          </div>
        </div>
      )}

      {/* Counter */}
      {total > 1 && (
        <div
          style={{
            position: "absolute",
            top: 50,
            right: 50,
            backgroundColor: "rgba(0,0,0,0.6)",
            padding: "10px 20px",
            borderRadius: 24,
          }}
        >
          <span
            style={{
              color: "white",
              fontSize: 24,
              fontFamily: "Arial, sans-serif",
              fontWeight: 600,
            }}
          >
            {index + 1} / {total}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const OutroCard: React.FC<{
  brandName: string;
  tagline: string;
  accent: string;
}> = ({ brandName, tagline, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "rgba(0,0,0,0.92)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ transform: `scale(${scale})`, textAlign: "center" }}>
        <h2
          style={{
            color: "white",
            fontSize: 68,
            fontFamily: "Arial, sans-serif",
            fontWeight: 900,
            margin: 0,
          }}
        >
          {brandName}
        </h2>
        <div
          style={{
            width: 100,
            height: 5,
            backgroundColor: accent,
            borderRadius: 3,
            margin: "20px auto",
          }}
        />
        <p
          style={{
            color: accent,
            fontSize: 34,
            fontFamily: "Arial, sans-serif",
            fontWeight: 600,
            margin: 0,
          }}
        >
          {tagline}
        </p>
      </div>
    </AbsoluteFill>
  );
};
