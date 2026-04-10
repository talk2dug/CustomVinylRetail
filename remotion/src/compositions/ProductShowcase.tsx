import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Props = {
  productName: string;
  productImage: string;
  backgroundColor: string;
};

export const ProductShowcase: React.FC<Props> = ({
  productName,
  productImage,
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 12 } });
  const titleOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [20, 40], [40, 0], {
    extrapolateRight: "clamp",
  });
  const badgeScale = spring({ frame: frame - 50, fps, config: { damping: 10 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {productImage && (
        <Img
          src={productImage}
          style={{
            width: 600,
            height: 600,
            objectFit: "contain",
            transform: `scale(${scale})`,
            borderRadius: 20,
          }}
        />
      )}
      {!productImage && (
        <div
          style={{
            width: 600,
            height: 600,
            backgroundColor: "#16213e",
            borderRadius: 20,
            transform: `scale(${scale})`,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            fontSize: 120,
          }}
        >
          🎨
        </div>
      )}
      <div
        style={{
          position: "absolute",
          bottom: 300,
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          textAlign: "center",
          padding: "0 40px",
        }}
      >
        <h1
          style={{
            color: "white",
            fontSize: 64,
            fontFamily: "Arial, sans-serif",
            fontWeight: "bold",
            textShadow: "0 4px 20px rgba(0,0,0,0.5)",
            margin: 0,
          }}
        >
          {productName}
        </h1>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 180,
          transform: `scale(${Math.max(0, badgeScale)})`,
          backgroundColor: "#e94560",
          padding: "16px 32px",
          borderRadius: 50,
        }}
      >
        <span
          style={{
            color: "white",
            fontSize: 28,
            fontFamily: "Arial, sans-serif",
            fontWeight: "bold",
          }}
        >
          Made in Asheville, NC
        </span>
      </div>
    </AbsoluteFill>
  );
};
