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
async function initVideoUpload(videoSize, chunkSize = null) {
  const tokens = loadTokens();
  if (!tokens || !tokens.open_id) {
    throw new Error('Not authenticated');
  }

  const body = {
    post_info: {
      title: '',
      privacy_level: 'SELF_ONLY', // Start as private, change when publishing
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSize
    }
  };

  if (chunkSize) {
    body.source_info.chunk_size = chunkSize;
    body.source_info.total_chunk_count = Math.ceil(videoSize / chunkSize);
  }

  return apiRequest('/post/publish/video/init/', 'POST', body);
}

/**
 * Upload video chunk
 */
async function uploadVideoChunk(uploadUrl, videoBuffer, chunkStart = 0, chunkEnd = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const chunk = chunkEnd ? videoBuffer.slice(chunkStart, chunkEnd) : videoBuffer;

    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': chunk.length
    };

    if (chunkEnd) {
      headers['Content-Range'] = `bytes ${chunkStart}-${chunkEnd - 1}/${videoBuffer.length}`;
    }

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: headers
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
 * Upload and publish a video file
 * @param {string} videoPath - Path to video file
 * @param {string} title - Video title/caption
 * @param {string} privacyLevel - PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
 */
async function uploadVideo(videoPath, title, privacyLevel = 'PUBLIC_TO_EVERYONE') {
  // Read video file
  const videoBuffer = fs.readFileSync(videoPath);
  const videoSize = videoBuffer.length;

  console.log(`[TikTok Content] Uploading video: ${videoPath} (${(videoSize / 1024 / 1024).toFixed(2)} MB)`);

  // Step 1: Initialize upload
  const initResult = await initVideoUpload(videoSize);

  if (!initResult.data || !initResult.data.upload_url) {
    throw new Error('Failed to initialize upload: ' + JSON.stringify(initResult));
  }

  const { upload_url, publish_id } = initResult.data;
  console.log(`[TikTok Content] Upload initialized, publish_id: ${publish_id}`);

  // Step 2: Upload video
  await uploadVideoChunk(upload_url, videoBuffer);
  console.log(`[TikTok Content] Video uploaded`);

  // Step 3: Publish
  const publishResult = await publishVideo(publish_id, title, privacyLevel);
  console.log(`[TikTok Content] Video published`);

  return {
    publish_id,
    status: publishResult
  };
}

/**
 * Upload video from URL
 */
async function uploadVideoFromUrl(videoUrl, title, privacyLevel = 'PUBLIC_TO_EVERYONE') {
  const tokens = loadTokens();
  if (!tokens || !tokens.open_id) {
    throw new Error('Not authenticated');
  }

  // IMPORTANT: Unaudited TikTok apps can ONLY post as SELF_ONLY (private)
  // Until the app passes TikTok's audit, public posts will be rejected with
  // "content-sharing-guidelines" error. Force SELF_ONLY for now.
  // To get audited: https://developers.tiktok.com/doc/content-posting-api-get-started
  const IS_AUDITED = true; // App approved by TikTok (Dec 2025)
  const effectivePrivacy = IS_AUDITED ? privacyLevel : 'SELF_ONLY';

  if (!IS_AUDITED && privacyLevel !== 'SELF_ONLY') {
    console.warn('[TikTok] App not audited - forcing SELF_ONLY privacy. Requested:', privacyLevel);
  }

  const body = {
    post_info: {
      title: title,
      privacy_level: effectivePrivacy,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl
    }
  };

  return apiRequest('/post/publish/video/init/', 'POST', body);
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
