import { Composition } from "remotion";
import { ProductShowcase } from "./compositions/ProductShowcase";
import { TikTokPromo } from "./compositions/TikTokPromo";
import { StickerReveal } from "./compositions/StickerReveal";
import {
  CatalogShowcase,
  catalogShowcaseSchema,
} from "./compositions/CatalogShowcase";
import { MockupReel, mockupReelSchema } from "./compositions/MockupReel";
import { FootageReel, footageReelSchema } from "./compositions/FootageReel";
import {
  MetalPrintStory,
  metalPrintStorySchema,
} from "./compositions/MetalPrintStory";
import {
  listArtwork,
  listAllMockups,
  listFootage,
  footageVideoUrl,
  assetUrl,
} from "./lib/api";

const FPS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ── Catalog Showcase — artwork slideshow by category ── */}
      <Composition
        id="CatalogShowcase"
        component={CatalogShowcase}
        schema={catalogShowcaseSchema}
        durationInFrames={300}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{
          category: "Asheville Art",
          limit: 5,
          title: "",
          subtitle: "Made in Asheville, NC",
          bgStart: "#0f0c29",
          bgEnd: "#302b63",
          accent: "#e94560",
          showCta: true,
          ctaText: "Shop Now →",
          showCategoryBadge: true,
          images: [] as string[],
          names: [] as string[],
          categoryBadge: "",
        }}
        calculateMetadata={async ({ props }) => {
          // If items already provided (from Reel Studio), skip auto-fetch
          if (props.images && props.images.length > 0) {
            const frames = Math.max(
              240,
              45 + props.images.length * 60 + (props.showCta ? 80 : 20)
            );
            return { props, durationInFrames: frames };
          }
          try {
            const artwork = await listArtwork({
              category: props.category || undefined,
              limit: props.limit,
            });
            const images = artwork.map((a) =>
              assetUrl(a.thumbnailPath || a.filePath)
            );
            const names = artwork.map((a) => a.title || "");
            const autoTitle =
              props.title ||
              (props.category
                ? props.category
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase())
                : "New Arrivals");
            const frames = Math.max(
              240,
              45 + images.length * 60 + (props.showCta ? 80 : 20)
            );
            return {
              props: {
                ...props,
                images,
                names,
                title: autoTitle,
                categoryBadge: props.showCategoryBadge ? props.category : "",
              },
              durationInFrames: frames,
            };
          } catch (e) {
            console.error("[CatalogShowcase] fetch failed:", e);
            return { props };
          }
        }}
      />

      {/* ── Mockup Reel — mixed apparel + custom art mockups ── */}
      <Composition
        id="MockupReel"
        component={MockupReel}
        schema={mockupReelSchema}
        durationInFrames={300}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{
          source: "all" as const,
          limit: 6,
          hookText: "Check out our latest drops",
          brandName: "BlueRidge Custom Co.",
          location: "Asheville, NC",
          bgColor: "#111111",
          accent: "#ff6b35",
          transition: "zoom" as const,
          panMode: "ken-burns" as const,
          imageScale: 1,
          imageOffsetX: 0,
          imageOffsetY: 0,
          panDistance: 30,
          slideSeconds: 2.5,
          panSpeed: 1,
          audioUrl: "",
          audioVolume: 1,
          ctaUrl: "",
          ctaLabel: "Shop Now:",
          mockupImages: [] as string[],
          labels: [] as string[],
          captions: [] as string[],
          subtitles: [] as string[],
          itemEffects: [] as Array<{
            panMode?: string;
            imageScale?: number;
            imageOffsetX?: number;
            imageOffsetY?: number;
            panDistance?: number;
            panSpeed?: number;
            slideSeconds?: number;
          }>,
        }}
        calculateMetadata={async ({ props }) => {
          // Sum per-item slide durations (or use global if no itemEffects)
          const computeDuration = (count: number) => {
            let totalSlideFrames = 0;
            for (let i = 0; i < count; i++) {
              const itemSeconds =
                props.itemEffects?.[i]?.slideSeconds ?? props.slideSeconds;
              totalSlideFrames += Math.max(15, Math.floor(itemSeconds * FPS));
            }
            return Math.max(150, 70 + totalSlideFrames + 45);
          };

          // If items already provided (from Reel Studio), skip auto-fetch
          if (props.mockupImages && props.mockupImages.length > 0) {
            return {
              props,
              durationInFrames: computeDuration(props.mockupImages.length),
            };
          }
          try {
            const mockups = await listAllMockups({
              source: props.source,
              limit: props.limit,
            });
            const mockupImages = mockups.map((m) => m.url);
            const labels = mockups.map((m) => m.label);
            return {
              props: { ...props, mockupImages, labels },
              durationInFrames: computeDuration(mockupImages.length),
            };
          } catch (e) {
            console.error("[MockupReel] fetch failed:", e);
            return { props };
          }
        }}
      />

      {/* ── Footage Reel — video clips from library ── */}
      <Composition
        id="FootageReel"
        component={FootageReel}
        schema={footageReelSchema}
        durationInFrames={600}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{
          category: "timelapse",
          limit: 5,
          maxFramesPerClip: 120,
          hookText: "Watch us print live",
          tagline: "Made in Asheville, NC",
          brandName: "BlueRidge Custom Co.",
          bgColor: "#000000",
          accent: "#ff6b35",
          showLabels: true,
          muteVideo: true,
          audioUrl: "",
          audioVolume: 1,
          clips: [] as {
            url: string;
            type: "video" | "image";
            label: string;
            durationInFrames: number;
          }[],
        }}
        calculateMetadata={async ({ props }) => {
          // If clips already provided (from Reel Studio), skip auto-fetch
          if (props.clips && props.clips.length > 0) {
            const clipsTotal = props.clips.reduce(
              (sum, c) => sum + (c.durationInFrames || 90),
              0
            );
            const frames = Math.max(300, 60 + clipsTotal + 60);
            return { props, durationInFrames: frames };
          }
          try {
            const footage = await listFootage({
              category: props.category || undefined,
              limit: props.limit,
            });
            const clips = footage.map((c) => {
              const seconds = c.duration_seconds || 3;
              const durationInFrames = Math.min(
                Math.max(Math.floor(seconds * FPS), 60),
                props.maxFramesPerClip
              );
              return {
                url: footageVideoUrl(c),
                type: "video" as const,
                label: c.category || c.subcategory || c.original_name.slice(0, 30),
                durationInFrames,
              };
            });
            // Hook (60) + all clips + outro (60)
            const clipsTotal = clips.reduce(
              (sum, c) => sum + c.durationInFrames,
              0
            );
            const frames = Math.max(300, 60 + clipsTotal + 60);
            return {
              props: { ...props, clips },
              durationInFrames: frames,
            };
          } catch (e) {
            console.error("[FootageReel] fetch failed:", e);
            return { props };
          }
        }}
      />

      {/* ── Metal Print Story — process + art + mockups + why-metal ── */}
      <Composition
        id="MetalPrintStory"
        component={MetalPrintStory}
        schema={metalPrintStorySchema}
        durationInFrames={900}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{
          hook: "Hand-finished metal prints",
          processIntro: "Watch it come to life",
          artExplainer:
            "Every detail pressed into metal.\nMade to live in the light.",
          whyMetal:
            "Museum-grade metal catches light and color that paper cannot.",
          ctaText: "Shop Now",
          outro: "Asheville, NC Studio",
          brandName: "BlueRidge Custom Co.",
          processClips: [] as { url: string; durationInFrames: number }[],
          mockupImages: [] as string[],
          heroImage: "",
          bgColor: "#0a0a0a",
          accent: "#c9a048",
          audioUrl: "",
          audioVolume: 1,
          ctaUrl: "",
        }}
        calculateMetadata={({ props }) => {
          // Compute total frames from content
          const HOOK = 75,
            PROCESS_INTRO = 45,
            HERO = 90,
            ART = 75,
            WHY = 90,
            OUTRO_F = 90;
          const MOCKUP_EACH = 90;
          const processTotal = (props.processClips || []).reduce(
            (sum, c) => sum + (c.durationInFrames || MOCKUP_EACH),
            0
          );
          const mockupTotal = (props.mockupImages || []).length * MOCKUP_EACH;
          const heroFrames = props.heroImage ? HERO : 0;
          const total =
            HOOK + PROCESS_INTRO + processTotal + heroFrames + ART + mockupTotal + WHY + OUTRO_F;
          return { props, durationInFrames: Math.max(450, total) };
        }}
      />

      {/* ── Original compositions ── */}
      <Composition
        id="ProductShowcase"
        component={ProductShowcase}
        durationInFrames={150}
        fps={FPS}
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
        fps={FPS}
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
        fps={FPS}
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
