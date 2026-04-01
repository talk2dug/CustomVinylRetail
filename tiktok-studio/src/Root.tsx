import { Composition } from "remotion";
import { TikTokVideo } from "./compositions/TikTokVideo";
import { TikTokSchema } from "./schemas/TikTokSchema";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TikTokVideo"
        component={TikTokVideo}
        durationInFrames={900}
        fps={30}
        width={1080}
        height={1920}
        schema={TikTokSchema}
        defaultProps={{
          scenes: [],
          transitions: [],
          textOverlays: [],
          musicTrack: null,
          musicVolume: 0.35,
          brandWatermark: true,
        }}
        calculateMetadata={({ props }) => {
          // Calculate total duration from scenes
          let totalFrames = 0;
          for (const scene of props.scenes) {
            const dur = (scene.trimEnd - scene.trimStart) / scene.playbackRate;
            totalFrames += Math.round(dur * 30);
          }
          // Add transition overlap
          for (const t of props.transitions) {
            totalFrames -= t.durationFrames;
          }
          return {
            durationInFrames: Math.max(totalFrames, 30),
          };
        }}
      />
    </>
  );
};
