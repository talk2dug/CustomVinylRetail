/**
 * Data bridge: fetch catalog, mockups, and artwork from vinylApp server
 * Used by Remotion compositions and Studio prop editors
 */

const API_BASE = "http://localhost:4000";
const API_KEY = "laZHEthV92qDq0adO07UnqoH3O4baZmV";

const headers = { "x-api-key": API_KEY };

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

export type Mockup = {
  id: number;
  file_path: string;
  graphic_path: string;
  garment_type: string;
  clothing_color: string;
  campaign_slug: string;
  mockup_type: string;
  human_model_id: number | null;
};

export type Category = {
  category: string;
  count: number;
};

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

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
  const qs = params.toString();
  const data = await fetchJson<{ artwork: Artwork[] }>(
    `/api/custom-art/artwork${qs ? `?${qs}` : ""}`
  );
  return data.artwork;
}

export async function listCategories(): Promise<Category[]> {
  const data = await fetchJson<{ categories: Category[] }>(
    "/api/custom-art/artwork/categories"
  );
  return data.categories;
}

export async function listMockups(opts?: {
  artworkId?: string;
  campaignSlug?: string;
  mockupType?: string;
}): Promise<Mockup[]> {
  const params = new URLSearchParams();
  if (opts?.artworkId) params.set("artworkId", opts.artworkId);
  if (opts?.campaignSlug) params.set("campaignSlug", opts.campaignSlug);
  if (opts?.mockupType) params.set("mockupType", opts.mockupType);
  params.set("activeOnly", "false");
  const qs = params.toString();
  return fetchJson<Mockup[]>(
    `/api/custom-art/mockups${qs ? `?${qs}` : ""}`
  );
}

/**
 * Convert a server file path to a URL accessible from Remotion Studio
 */
export function assetUrl(filePath: string): string {
  if (!filePath) return "";
  if (filePath.startsWith("http")) return filePath;
  // Files under library/ are served by nginx
  if (filePath.startsWith("library/")) {
    return `${API_BASE}/${filePath}`;
  }
  // Files under /mnt/websit are served at /library/
  if (filePath.startsWith("/mnt/websit/")) {
    return `${API_BASE}/library/${filePath.replace("/mnt/websit/", "")}`;
  }
  // Files under /mnt/dbFiles
  if (filePath.startsWith("/mnt/dbFiles/")) {
    return `${API_BASE}/library/dbfiles/${filePath.replace("/mnt/dbFiles/", "")}`;
  }
  return `${API_BASE}/${filePath}`;
}
