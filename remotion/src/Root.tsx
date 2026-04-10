import { Composition } from "remotion";
import { ProductShowcase } from "./compositions/ProductShowcase";
import { TikTokPromo } from "./compositions/TikTokPromo";
import { StickerReveal } from "./compositions/StickerReveal";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ProductShowcase"
        component={ProductShowcase}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          productName: "Custom Vinyl Sticker",
          productImage: "",
          backgroundColor: "#1a1a2e",
        }}
      />
      <Composition
        id="TikTokPromo"
        component={TikTokPromo}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          headline: "Made in Asheville, NC",
          subheadline: "Custom Vinyl & 3D Prints",
          productImages: [] as string[],
          accentColor: "#e94560",
        }}
      />
      <Composition
        id="StickerReveal"
        component={StickerReveal}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          stickerImage: "",
          stickerName: "Custom Sticker",
          backgroundColor: "#0f3460",
        }}
      />
    </>
  );
};
