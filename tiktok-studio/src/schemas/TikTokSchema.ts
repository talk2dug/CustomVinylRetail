import { z } from "zod";

export const SceneSchema = z.object({
  clipFilename: z.string(),
  trimStart: z.number().default(0),
  trimEnd: z.number().default(5),
  playbackRate: z.number().default(1),
  role: z.enum(["hook", "process", "reveal", "cta", "b-roll", "transition"]).default("b-roll"),
});

export const TransitionSchema = z.object({
  type: z.enum(["fade", "slide", "wipe", "cut"]).default("cut"),
  durationFrames: z.number().default(8),
});

export const TextOverlaySchema = z.object({
  text: z.string(),
  startFrame: z.number(),
  durationFrames: z.number().default(60),
  position: z.enum(["top", "center", "bottom"]).default("center"),
  animation: z.enum(["fade-in", "typewriter", "slide-up", "pop"]).default("fade-in"),
  style: z.object({
    fontSize: z.number().default(64),
    color: z.string().default("#FFFFFF"),
    backgroundColor: z.string().optional(),
  }).default({}),
});

export const TikTokSchema = z.object({
  scenes: z.array(SceneSchema),
  transitions: z.array(TransitionSchema),
  textOverlays: z.array(TextOverlaySchema),
  musicTrack: z.string().nullable().default(null),
  musicVolume: z.number().default(0.35),
  brandWatermark: z.boolean().default(true),
});

export type TikTokProps = z.infer<typeof TikTokSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
