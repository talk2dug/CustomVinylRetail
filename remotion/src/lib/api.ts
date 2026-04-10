/**
 * Data bridge: fetch catalog, mockups, artwork, and footage from vinylApp server
 * Used by Remotion compositions and Studio prop editors
 */

// Studio runs on port 3101; API calls go to the main vinylApp server on the public domain
const API_BASE =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}`
    : "https://blueridgecustomco.com";
const API_KEY = "laZHEthV92qDq0adO07UnqoH3O4baZmV";

const headers = { "x-api-key": API_KEY };

// ─── Types ───────────────────────────────────────────────────────────────────

export type Artwork = {
  id: string;
  title: string;
  description: string | null;
  tags: string;
  category: string;
  style: string;
  filePath: string;
  thumbnailPath: string;
  previewPath: string;
  theme: string;
  mood: string;
  colors: string[];
  keywords: string[];
  suggestedShirtColors: string[];
  status: string;
  active: boolean;
};

/** Custom art mockup (wall art, canvas prints, etc.) */
export type CustomArtMockup = {
  id: number;
  title?: string;
  filename?: string;
  filePath?: string;
  url?: string;
  productId?: string;
  artworkId?: string;
  roomId?: string;
  campaignSlug?: string;
  mockupType?: string;
  width?: number;
  height?: number;
  tags?: string;
  active?: boolean;
  artwork?: { title?: string; thumbnail?: string };
  room?: { title?: string; thumbnail?: string };
};

/** Apparel mockup (generated via batch mockup generator) */
export type ApparelMockup = {
  filename: string;
  url: string;
  size: number;
  createdAt: string;
};

/** Unified mockup shape for compositions */
export type UnifiedMockup = {
  id: string;
  url: string;
  label: string;
  source: "apparel" | "custom-art";
  thumbnail?: string;
  createdAt?: string;
};

/** Footage clip (video from timelapse, camera, phone) */
export type FootageClip = {
  id: string;
  filename: string;
  original_name: string;
  file_path: string;
  file_size: number;
  duration_seconds: number;
  mime_type: string;
  category: string | null;
  subcategory: string | null;
  product_name: string | null;
  tags: string | null;
  notes: string | null;
  thumbnail_path: string | null;
  status: string;
  source: string;
  width: number | null;
  height: number | null;
  created_at: string;
};

export type Category = { category: string; count: number } | string;

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Artwork ─────────────────────────────────────────────────────────────────

export async function listArtwork(opts?: {
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Artwork[]> {
  const params = new URLSearchParams();
  if (opts?.category) params.set("category", opts.category);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  params.set("activeOnly", "false");
  const data = await fetchJson<{ artwork: Artwork[] }>(
    `/api/custom-art/artwork?${params}`
  );
  return data.artwork;
}

export async function listArtworkCategories(): Promise<string[]> {
  const data = await fetchJson<{ categories: (string | Category)[] }>(
    "/api/custom-art/artwork/categories"
  );
  return data.categories.map((c) => (typeof c === "string" ? c : c.category));
}

// ─── Custom Art Mockups ──────────────────────────────────────────────────────

export async function listCustomArtMockups(opts?: {
  artworkId?: string;
  campaignSlug?: string;
  mockupType?: string;
}): Promise<CustomArtMockup[]> {
  const params = new URLSearchParams({ activeOnly: "false" });
  if (opts?.artworkId) params.set("artworkId", opts.artworkId);
  if (opts?.campaignSlug) params.set("campaignSlug", opts.campaignSlug);
  if (opts?.mockupType) params.set("mockupType", opts.mockupType);
  return fetchJson<CustomArtMockup[]>(`/api/custom-art/mockups?${params}`);
}

// ─── Apparel Mockups ─────────────────────────────────────────────────────────

export async function listApparelMockups(): Promise<ApparelMockup[]> {
  const data = await fetchJson<{ mockups: ApparelMockup[]; total: number }>(
    "/api/batch-mockups"
  );
  return data.mockups;
}

// ─── Unified mockups (both sources) ──────────────────────────────────────────

export async function listAllMockups(opts?: {
  source?: "apparel" | "custom-art" | "all";
  limit?: number;
}): Promise<UnifiedMockup[]> {
  const source = opts?.source || "all";
  const results: UnifiedMockup[] = [];

  if (source === "all" || source === "apparel") {
    try {
      const apparel = await listApparelMockups();
      for (const m of apparel) {
        results.push({
          id: `apparel:${m.filename}`,
          url: `${API_BASE}${m.url}`,
          label: m.filename.replace(/^mockup_/, "").replace(/\.[^.]+$/, ""),
          source: "apparel",
          createdAt: m.createdAt,
        });
      }
    } catch (e) {
      console.error("[api] apparel mockups failed:", e);
    }
  }

  if (source === "all" || source === "custom-art") {
    try {
      const custom = await listCustomArtMockups();
      for (const m of custom) {
        const url = m.url || (m.filePath ? `${API_BASE}/${m.filePath}` : "");
        if (!url) continue;
        results.push({
          id: `custom-art:${m.id}`,
          url: url.startsWith("http") ? url : `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`,
          label: m.title || m.artwork?.title || m.filename || `Mockup ${m.id}`,
          source: "custom-art",
        });
      }
    } catch (e) {
      console.error("[api] custom-art mockups failed:", e);
    }
  }

  const limit = opts?.limit;
  return limit ? results.slice(0, limit) : results;
}

// ─── Footage Library ─────────────────────────────────────────────────────────

export async function listFootage(opts?: {
  category?: string;
  subcategory?: string;
  search?: string;
  tags?: string;
  limit?: number;
  offset?: number;
}): Promise<FootageClip[]> {
  const params = new URLSearchParams();
  if (opts?.category) params.set("category", opts.category);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.tags) params.set("tags", opts.tags);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const data = await fetchJson<{ items: FootageClip[] }>(
    `/api/footage/clips?${params}`
  );
  const items = data.items || [];
  return opts?.subcategory
    ? items.filter((c) => c.subcategory === opts.subcategory)
    : items;
}

export async function listFootageCategories(): Promise<string[]> {
  const data = await fetchJson<{ categories: string[] }>(
    "/api/footage/categories"
  );
  return data.categories || [];
}

/** Get video URL for a footage clip (streams via footage-server) */
export function footageVideoUrl(clip: FootageClip): string {
  return `${API_BASE}/api/footage/file/${clip.filename}?key=${API_KEY}`;
}

/** Get thumbnail URL for a footage clip */
export function footageThumbUrl(clip: FootageClip): string {
  if (!clip.thumbnail_path) return "";
  const thumbName = clip.thumbnail_path.split("/").pop() || "";
  return `${API_BASE}/api/footage/thumb/${thumbName}`;
}

// ─── Asset URL resolver ──────────────────────────────────────────────────────

/**
 * Convert a server file path to a URL accessible from Remotion Studio.
 * Handles various path conventions used across the vinylApp database.
 */
export function assetUrl(filePath: string): string {
  if (!filePath) return "";
  if (filePath.startsWith("http")) return filePath;
  if (filePath.startsWith("library/")) return `${API_BASE}/${filePath}`;
  if (filePath.startsWith("/mnt/websit/"))
    return `${API_BASE}/library/${filePath.replace("/mnt/websit/", "")}`;
  if (filePath.startsWith("/mnt/dbFiles/apparel-mockups/"))
    return `${API_BASE}/apparel-mockups/${filePath.replace("/mnt/dbFiles/apparel-mockups/", "")}`;
  if (filePath.startsWith("/apparel-mockups/"))
    return `${API_BASE}${filePath}`;
  if (filePath.startsWith("images/")) return `${API_BASE}/${filePath}`;
  if (filePath.startsWith("/")) return `${API_BASE}${filePath}`;
  return `${API_BASE}/${filePath}`;
}
