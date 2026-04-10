import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";
import { z } from "zod";

export const catalogShowcaseSchema = z.object({
  /** Title displayed at the top */
  title: z.string().default("New Arrivals"),
  /** Subtitle / tagline */
  subtitle: z.string().default("Made in Asheville, NC"),
  /** Array of image URLs to showcase */
  images: z.array(z.string()).default([]),
  /** Array of product names (matches images) */
  names: z.array(z.string()).default([]),
  /** Background gradient start color */
  bgStart: z.string().default("#0f0c29"),
  /** Background gradient end color */
  bgEnd: z.string().default("#302b63"),
  /** Accent color for highlights */
  accent: z.string().default("#e94560"),
  /** Show "Shop Now" CTA */
  showCta: z.boolean().default(true),
  /** CTA text */
  ctaText: z.string().default("Shop Now →"),
  /** Category badge text (empty = hidden) */
  categoryBadge: z.string().default(""),
});

type Props = z.infer<typeof catalogShowcaseSchema>;

export const CatalogShowcase: React.FC<Props> = ({
  title,
  subtitle,
  images,
  names,
  bgStart,
  bgEnd,
  accent,
  showCta,
  ctaText,
  categoryBadge,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const itemCount = images.length || 1;

  // Title entrance
  const titleScale = spring({ frame, fps, config: { damping: 10 } });
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Subtitle entrance
  const subY = interpolate(frame, [15, 35], [30, 0], {
    extrapolateRight: "clamp",
  });
  const subOpacity = interpolate(frame, [15, 35], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Category badge
  const badgeScale = spring({
    frame: frame - 5,
    fps,
    config: { damping: 8 },
  });

  // Outro fade
  const outroOpacity = interpolate(
    frame,
    [durationInFrames - 20, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Each image gets equal time, starting from frame 45
  const imageStartFrame = 45;
  const imageAreaFrames = durationInFrames - imageStartFrame - (showCta ? 60 : 20);
  const framesPerImage = Math.max(45, Math.floor(imageAreaFrames / itemCount));

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(155deg, ${bgStart} 0%, ${bgEnd} 100%)`,
        opacity: outroOpacity,
      }}
    >
      {/* Category badge */}
      {categoryBadge && (
        <div
          style={{
            position: "absolute",
            top: 100,
            width: "100%",
            display: "flex",
            justifyContent: "center",
            transform: `scale(${Math.max(0, badgeScale)})`,
          }}
        >
          <div
            style={{
              backgroundColor: accent + "30",
              border: `2px solid ${accent}`,
              padding: "10px 28px",
              borderRadius: 40,
            }}
          >
            <span
              style={{
                color: accent,
                fontSize: 26,
                fontFamily: "Arial, sans-serif",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 2,
              }}
            >
              {categoryBadge}
            </span>
          </div>
        </div>
      )}

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: categoryBadge ? 170 : 130,
          width: "100%",
          textAlign: "center",
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
        }}
      >
        <h1
          style={{
            color: "white",
            fontSize: 68,
            fontFamily: "Arial, sans-serif",
            fontWeight: 900,
            margin: 0,
            padding: "0 50px",
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>
      </div>

      {/* Subtitle */}
      <div
        style={{
          position: "absolute",
          top: categoryBadge ? 280 : 240,
          width: "100%",
          textAlign: "center",
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
        }}
      >
        <p
          style={{
            color: accent,
            fontSize: 34,
            fontFamily: "Arial, sans-serif",
            fontWeight: 600,
            margin: 0,
          }}
        >
          {subtitle}
        </p>
      </div>

      {/* Image carousel */}
      {images.map((img, i) => (
        <Sequence
          key={i}
          from={imageStartFrame + i * framesPerImage}
          durationInFrames={framesPerImage + 15}
        >
          <ImageCard
            image={img}
            name={names[i] || ""}
            accent={accent}
            index={i}
            total={images.length}
          />
        </Sequence>
      ))}

      {/* Placeholder when no images */}
      {images.length === 0 && (
        <div
          style={{
            position: "absolute",
            top: "45%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "white",
            fontSize: 24,
            fontFamily: "Arial, sans-serif",
            opacity: 0.5,
          }}
        >
          Add artwork images via props panel →
        </div>
      )}

      {/* CTA */}
      {showCta && (
        <Sequence from={durationInFrames - 80}>
          <CTAButton
            text={ctaText}
            accent={accent}
          />
        </Sequence>
      )}

      {/* Bottom branding */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          width: "100%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            color: "rgba(255,255,255,0.4)",
            fontSize: 20,
            fontFamily: "Arial, sans-serif",
          }}
        >
          BlueRidge Custom Co. • Asheville, NC
        </span>
      </div>
    </AbsoluteFill>
  );
};

const ImageCard: React.FC<{
  image: string;
  name: string;
  accent: string;
  index: number;
  total: number;
}> = ({ image, name, accent, index, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enterScale = spring({ frame, fps, config: { damping: 12, mass: 0.8 } });
  const exitOpacity = interpolate(frame, [60, 75], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const nameOpacity = interpolate(frame, [15, 25], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        top: "48%",
        left: "50%",
        transform: `translate(-50%, -50%) scale(${enterScale})`,
        opacity: frame < 60 ? 1 : exitOpacity,
      }}
    >
      <div
        style={{
          borderRadius: 20,
          overflow: "hidden",
          boxShadow: `0 20px 60px rgba(0,0,0,0.5), 0 0 0 3px ${accent}40`,
        }}
      >
        <Img
          src={image}
          style={{
            width: 700,
            height: 700,
            objectFit: "cover",
          }}
        />
      </div>
      {name && (
        <div
          style={{
            textAlign: "center",
            marginTop: 20,
            opacity: nameOpacity,
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
            {name}
          </span>
          {total > 1 && (
            <span
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 22,
                marginLeft: 12,
              }}
            >
              {index + 1}/{total}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const CTAButton: React.FC<{ text: string; accent: string }> = ({
  text,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 10 } });
  const pulse = Math.sin(frame * 0.08) * 0.03 + 1;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 200,
        width: "100%",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          backgroundColor: accent,
          padding: "22px 50px",
          borderRadius: 60,
          transform: `scale(${Math.max(0, scale) * pulse})`,
          boxShadow: `0 8px 30px ${accent}60`,
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
          {text}
        </span>
      </div>
    </div>
  );
};
