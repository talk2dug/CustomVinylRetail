/**
 * TikTok Content Posting API Integration
 *
 * Posts videos to TikTok using the Content Posting API
 * Uses TikTok for Business credentials (different from TikTok Shop)
 *
 * API Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Configuration - TikTok for Business credentials
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_APP_KEY || '';
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || process.env.TIKTOK_APP_SECRET || '';
const REDIRECT_URI = process.env.TIKTOK_CONTENT_REDIRECT_URI || 'https://blueridgecustomco.com/api/tiktok-content/auth-callback';

// API URLs
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const API_BASE = 'https://open.tiktokapis.com/v2';

// Token storage
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tiktok-content-tokens.json');

/**
 * Generate OAuth authorization URL
 */
function getAuthUrl(state = 'state') {
  const scopes = [
    'user.info.basic',
    'video.upload',
    'video.publish'
  ].join(',');

  const params = new URLSearchParams({
    client_key: CLIENT_KEY,
    response_type: 'code',
    scope: scopes,
    redirect_uri: REDIRECT_URI,
    state: state
  });

  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    }).toString();

    const url = new URL(TOKEN_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }

          // Save tokens
          const tokens = {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_in: response.expires_in,
            refresh_expires_in: response.refresh_expires_in,
            open_id: response.open_id,
            scope: response.scope,
            token_type: response.token_type,
            obtained_at: Date.now()
          };

          saveTokens(tokens);
          resolve(tokens);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Refresh access token
 */
async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    }).toString();

    const url = new URL(TOKEN_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }

          const newTokens = {
            ...tokens,
            access_token: response.access_token,
            refresh_token: response.refresh_token || tokens.refresh_token,
            expires_in: response.expires_in,
            obtained_at: Date.now()
          };

          saveTokens(newTokens);
          resolve(newTokens);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Get valid access token (refresh if needed)
 */
async function getValidToken() {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error('Not authenticated. Please authorize first.');
  }

  // Check if token is expired (with 5 min buffer)
  const expiresAt = tokens.obtained_at + (tokens.expires_in * 1000) - (5 * 60 * 1000);
  if (Date.now() > expiresAt) {
    console.log('[TikTok Content] Token expired, refreshing...');
    const newTokens = await refreshAccessToken();
    return newTokens.access_token;
  }

  return tokens.access_token;
}

/**
 * Make authenticated API request
 */
async function apiRequest(endpoint, method = 'GET', body = null) {
  const accessToken = await getValidToken();

  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${endpoint}`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error && response.error.code !== 'ok') {
            reject(new Error(response.error.message || JSON.stringify(response.error)));
            return;
          }
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Get user info
 */
async function getUserInfo() {
  const tokens = loadTokens();
  if (!tokens || !tokens.open_id) {
    throw new Error('Not authenticated');
  }

  return apiRequest(`/user/info/?fields=open_id,union_id,avatar_url,display_name`);
}

/**
 * Initialize video upload - Step 1
 * Returns upload URL for the video file
 */
/**
 * Initialize a video upload.
 *
 * TikTok has two init endpoints:
 *   - /post/publish/video/init/        "Direct Post" — requires the app to be
 *     separately audited for direct publishing. Sends post_info (title,
 *     privacy, etc.) so the video goes straight to the user's feed.
 *   - /post/publish/inbox/video/init/  "Upload to drafts" — only requires the
 *     video.upload scope. Video lands in the user's TikTok app drafts/inbox;
 *     they finish posting (caption, sound, cover, privacy) from the app.
 *
 * Most apps only have the upload scope audited (not direct publish), so
 * `mode: 'inbox'` is the safe default and matches the "post to drafts,
 * finish in app" workflow this project uses. Pass `mode: 'direct'` when
 * you know the app is audited for direct publishing.
 */
async function initVideoUpload(videoSize, {
  chunkSize = null,
  title = '',
  privacyLevel = 'SELF_ONLY',
  mode = 'inbox'
} = {}) {
  const tokens = loadTokens();
  if (!tokens || !tokens.open_id) {
    throw new Error('Not authenticated');
  }

  // TikTok's FILE_UPLOAD init REQUIRES video_size + chunk_size +
  // total_chunk_count, otherwise the API answers "The video info is empty".
  // < 64 MB → single chunk; larger → 10 MB chunks.
  const MAX_SINGLE_CHUNK = 64 * 1024 * 1024; // 64 MB
  const DEFAULT_CHUNK    = 10 * 1024 * 1024; // 10 MB
  let effectiveChunk = chunkSize;
  if (!effectiveChunk) {
    effectiveChunk = videoSize <= MAX_SINGLE_CHUNK ? videoSize : DEFAULT_CHUNK;
  }
  const totalChunks = Math.ceil(videoSize / effectiveChunk);

  const sourceInfo = {
    source: 'FILE_UPLOAD',
    video_size: videoSize,
    chunk_size: effectiveChunk,
    total_chunk_count: totalChunks
  };

  // Inbox flow does NOT accept post_info. Direct-post flow requires it.
  const body = mode === 'direct'
    ? {
        post_info: {
          title: title || '',
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false
        },
        source_info: sourceInfo
      }
    : { source_info: sourceInfo };

  const endpoint = mode === 'direct'
    ? '/post/publish/video/init/'
    : '/post/publish/inbox/video/init/';

  return apiRequest(endpoint, 'POST', body);
}

/**
 * Upload a byte range to the TikTok-provided upload URL. TikTok REQUIRES
 * Content-Range on every PUT, even when the whole file fits in a single chunk.
 */
async function uploadVideoChunk(uploadUrl, videoBuffer, chunkStart = 0, chunkEnd = null, totalSize = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const end = chunkEnd != null ? chunkEnd : videoBuffer.length;
    const chunk = videoBuffer.slice(chunkStart, end);
    const total = totalSize != null ? totalSize : videoBuffer.length;

    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': chunk.length,
      'Content-Range': `bytes ${chunkStart}-${end - 1}/${total}`
    };

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, statusCode: res.statusCode });
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(chunk);
    req.end();
  });
}

/**
 * Publish video - Final step
 */
async function publishVideo(publishId, title, privacyLevel = 'PUBLIC_TO_EVERYONE') {
  const body = {
    publish_id: publishId,
    post_info: {
      title: title,
      privacy_level: privacyLevel, // PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    }
  };

  return apiRequest('/post/publish/status/update/', 'POST', body);
}

/**
 * Check publish status
 */
async function getPublishStatus(publishId) {
  return apiRequest(`/post/publish/status/fetch/?publish_id=${publishId}`);
}

/**
 * Upload a video file to TikTok. The FILE_UPLOAD flow is:
 *   1. POST /post/publish/video/init/ with post_info + source_info
 *      → returns { upload_url, publish_id }. Privacy + title are set HERE;
 *      there is NO second "publish" call.
 *   2. PUT bytes to upload_url with Content-Range (even for single chunks).
 *   3. Poll /post/publish/status/fetch/?publish_id=... for PROCESSING/DONE.
 *
 * Unaudited apps can only post with privacy_level=SELF_ONLY. Audited apps
 * can post PUBLIC_TO_EVERYONE / MUTUAL_FOLLOW_FRIENDS / SELF_ONLY.
 *
 * @param {string} videoPath      - Local path to the .mp4 file
 * @param {string} title          - Caption / video title
 * @param {string} privacyLevel   - PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | SELF_ONLY
 */
async function uploadVideo(videoPath, title, privacyLevel = 'PUBLIC_TO_EVERYONE', { mode = 'inbox' } = {}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  const videoBuffer = fs.readFileSync(videoPath);
  const videoSize = videoBuffer.length;
  const sizeMb = (videoSize / 1024 / 1024).toFixed(2);

  if (videoSize < 1024 * 1024) {
    throw new Error(`Video too small (${sizeMb} MB). TikTok requires at least ~1MB.`);
  }

  console.log(`[TikTok Content] Uploading ${videoPath} (${sizeMb} MB, mode=${mode}, privacy=${privacyLevel})`);

  // Step 1 — init (inbox mode = lands in drafts; direct mode = straight to feed)
  const initResult = await initVideoUpload(videoSize, { title, privacyLevel, mode });
  if (!initResult?.data?.upload_url || !initResult?.data?.publish_id) {
    throw new Error('Init failed: ' + JSON.stringify(initResult));
  }
  const { upload_url, publish_id } = initResult.data;
  console.log(`[TikTok Content] Init ok — publish_id=${publish_id}`);

  // Step 2 — PUT the bytes. For < 64 MB we send one request covering the
  // whole file, with Content-Range: bytes 0-(N-1)/N.
  const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
  if (videoSize <= MAX_SINGLE_CHUNK) {
    await uploadVideoChunk(upload_url, videoBuffer, 0, videoSize, videoSize);
    console.log(`[TikTok Content] Bytes uploaded (single chunk)`);
  } else {
    const CHUNK = 10 * 1024 * 1024;
    for (let start = 0; start < videoSize; start += CHUNK) {
      const end = Math.min(start + CHUNK, videoSize);
      await uploadVideoChunk(upload_url, videoBuffer, start, end, videoSize);
      console.log(`[TikTok Content] Chunk uploaded ${start}-${end}/${videoSize}`);
    }
  }

  // Step 3 — return publish_id so the caller can poll status.
  return { publish_id, uploadUrl: upload_url, sizeBytes: videoSize };
}

/**
 * Upload video from URL
 */
async function uploadVideoFromUrl(videoUrl, title, privacyLevel = 'PUBLIC_TO_EVERYONE', { mode = 'inbox' } = {}) {
  const tokens = loadTokens();
  if (!tokens || !tokens.open_id) {
    throw new Error('Not authenticated');
  }

  // Inbox flow does NOT accept post_info; direct-post requires it.
  const sourceInfo = { source: 'PULL_FROM_URL', video_url: videoUrl };
  const body = mode === 'direct'
    ? {
        post_info: {
          title: title,
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false
        },
        source_info: sourceInfo
      }
    : { source_info: sourceInfo };

  const endpoint = mode === 'direct'
    ? '/post/publish/video/init/'
    : '/post/publish/inbox/video/init/';

  const result = await apiRequest(endpoint, 'POST', body);
  return {
    publish_id: result?.data?.publish_id,
    mode,
    raw: result
  };
}

// Token storage helpers
function saveTokens(tokens) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function isAuthenticated() {
  const tokens = loadTokens();
  return tokens && tokens.access_token;
}

function getConnectionStatus() {
  const tokens = loadTokens();
  if (!tokens) {
    return { connected: false, message: 'Not connected' };
  }

  const expiresAt = tokens.obtained_at + (tokens.expires_in * 1000);
  const isExpired = Date.now() > expiresAt;

  return {
    connected: !isExpired,
    open_id: tokens.open_id,
    scope: tokens.scope,
    expires_at: new Date(expiresAt).toISOString(),
    is_expired: isExpired
  };
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidToken,
  getUserInfo,
  uploadVideo,
  uploadVideoFromUrl,
  getPublishStatus,
  isAuthenticated,
  getConnectionStatus,
  loadTokens
};
