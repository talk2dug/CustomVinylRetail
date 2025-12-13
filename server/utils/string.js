/**
 * Shared String Utilities
 * Consolidated from: catalog-metadata-generator.js, catalog-ocr-generator.js, save-design-server.js
 */

const path = require('path');

/**
 * Convert a string to a URL-safe slug
 * @param {string} value - The string to slugify
 * @param {number} maxLength - Maximum length of the slug (default: 64)
 * @returns {string} The slugified string
 */
function slugify(value, maxLength = 64) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength) || 'untitled';
}

/**
 * Check if a file should be ignored (macOS junk files, Windows thumbnails, etc.)
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if the file is junk
 */
function isJunkFile(filePath) {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  if (name.startsWith('._')) return true;
  if (name === '.ds_store' || lower === '.ds_store') return true;
  if (lower === 'thumbs.db') return true;
  return false;
}

/**
 * Format a filename into a human-readable display name
 * @param {string} rawName - The raw filename
 * @returns {string} Formatted display name
 */
function formatDisplayName(rawName) {
  return rawName
    .replace(/\.[^/.]+$/, '')     // Remove extension
    .replace(/[_-]+/g, ' ')       // Replace underscores/hyphens with spaces
    .replace(/\s+/g, ' ')         // Normalize whitespace
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()); // Title case
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} value - The string to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize and validate a URL
 * @param {string} value - The URL to sanitize
 * @returns {string|null} Valid URL or null if invalid
 */
function sanitizeUrl(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // Allow relative paths for product images
  if (/^\/productimages\//.test(trimmed)) {
    return trimmed;
  }

  // Require http:// or https:// for external URLs
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    return new URL(trimmed).toString();
  } catch (error) {
    return null;
  }
}

module.exports = {
  slugify,
  isJunkFile,
  formatDisplayName,
  escapeHtml,
  sanitizeUrl
};
