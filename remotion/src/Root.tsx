import { Composition, Still } from "remotion";
import { ProductShowcase } from "./compositions/ProductShowcase";
import { TikTokPromo } from "./compositions/TikTokPromo";
import { StickerReveal } from "./compositions/StickerReveal";
import {
  CatalogShowcase,
  catalogShowcaseSchema,
} from "./compositions/CatalogShowcase";
import { MockupReel, mockupReelSchema } from "./compositions/MockupReel";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ── Catalog-driven compositions ── */}
      <Composition
        id="CatalogShowcase"
        component={CatalogShowcase}
        schema={catalogShowcaseSchema}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          title: "New Arrivals",
          subtitle: "Made in Asheville, NC",
          images: [],
          names: [],
          bgStart: "#0f0c29",
          bgEnd: "#302b63",
          accent: "#e94560",
          showCta: true,
          ctaText: "Shop Now →",
          categoryBadge: "",
        }}
      />
      <Composition
        id="MockupReel"
        component={MockupReel}
        schema={mockupReelSchema}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          mockupImages: [],
          labels: [],
          hookText: "Check out our latest drops",
          brandName: "BlueRidge Custom Co.",
          location: "Asheville, NC",
          bgColor: "#111111",
          accent: "#ff6b35",
          transition: "zoom" as const,
        }}
      />

      {/* ── Original compositions ── */}
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
