#!/usr/bin/env node

/**
 * Extract a representative color palette from an image.
 *
 * Usage:
 *   node scripts/extract-colors.js path/to/image.jpg --colors=8 --json
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_COLORS = 8;
const MAX_ITERATIONS = 20;

function parseArguments(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0].startsWith('--')) {
    return { showHelp: true };
  }

  const params = {
    inputPath: args[0],
    colors: DEFAULT_COLORS,
    outputJson: false
  };

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--colors=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) {
        params.colors = Math.max(1, Math.min(32, Math.round(value)));
      }
    } else if (arg === '--json') {
      params.outputJson = true;
    } else if (arg === '--help' || arg === '-h') {
      return { showHelp: true };
    }
  }

  return params;
}

function toHex(value) {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

function rgbToHex({ r, g, b }) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function squaredDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function initializeCentroids(pixels, k) {
  if (pixels.length === 0) return [];
  const centroids = [];
  const step = Math.max(1, Math.floor(pixels.length / k));
  for (let i = 0; i < k; i += 1) {
    const index = Math.min(pixels.length - 1, i * step);
    centroids.push({ ...pixels[index] });
  }
  return centroids;
}

function recalculateCentroids(assignments, pixels, k) {
  const accumulators = new Array(k).fill(null).map(() => ({
    r: 0,
    g: 0,
    b: 0,
    count: 0
  }));

  assignments.forEach((clusterIndex, idx) => {
    const pixel = pixels[idx];
    const bucket = accumulators[clusterIndex];
    bucket.r += pixel.r;
    bucket.g += pixel.g;
    bucket.b += pixel.b;
    bucket.count += 1;
  });

  return accumulators.map((bucket, index) => {
    if (!bucket.count) {
      return { ...pixels[Math.floor(Math.random() * pixels.length)] };
    }
    return {
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count
    };
  });
}

function runKMeans(pixels, k) {
  if (pixels.length === 0) return [];
  const centroids = initializeCentroids(pixels, k);
  let assignments = new Array(pixels.length).fill(0);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    let changes = 0;

    assignments = assignments.map((currentCluster, idx) => {
      const pixel = pixels[idx];
      let nearestCluster = currentCluster;
      let nearestDistance = squaredDistance(pixel, centroids[currentCluster]);
      for (let c = 0; c < centroids.length; c += 1) {
        if (c === currentCluster) continue;
        const dist = squaredDistance(pixel, centroids[c]);
        if (dist < nearestDistance) {
          nearestCluster = c;
          nearestDistance = dist;
        }
      }
      if (nearestCluster !== currentCluster) {
        changes += 1;
      }
      return nearestCluster;
    });

    const nextCentroids = recalculateCentroids(assignments, pixels, k);
    centroids.splice(0, centroids.length, ...nextCentroids);

    if (changes === 0) {
      break;
    }
  }

  const clusters = centroids.map(() => ({
    r: 0,
    g: 0,
    b: 0,
    count: 0
  }));

  assignments.forEach((clusterIndex, idx) => {
    const pixel = pixels[idx];
    const cluster = clusters[clusterIndex];
    cluster.r += pixel.r;
    cluster.g += pixel.g;
    cluster.b += pixel.b;
    cluster.count += 1;
  });

  return clusters
    .filter((cluster) => cluster.count > 0)
    .map((cluster) => ({
      r: cluster.r / cluster.count,
      g: cluster.g / cluster.count,
      b: cluster.b / cluster.count,
      count: cluster.count
    }));
}

async function extractPixels(imagePath) {
  const image = sharp(imagePath)
    .resize(200, 200, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .removeAlpha();

  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    pixels.push({
      r: data[i],
      g: data[i + 1],
      b: data[i + 2]
    });
  }
  return pixels;
}

function formatPalette(clusters, totalPixels) {
  return clusters
    .map((cluster) => {
      const rgb = {
        r: Math.round(cluster.r),
        g: Math.round(cluster.g),
        b: Math.round(cluster.b)
      };
      const ratio = cluster.count / totalPixels;
      return {
        hex: rgbToHex(rgb),
        rgb,
        ratio,
        percentage: ratio * 100,
        count: cluster.count
      };
    })
    .sort((a, b) => b.count - a.count);
}

function printTable(palette) {
  const rows = palette.map((entry) => {
    const { hex, rgb, percentage } = entry;
    return `${hex.padEnd(8)} rgb(${rgb.r.toString().padStart(3)}, ${rgb.g
      .toString()
      .padStart(3)}, ${rgb.b.toString().padStart(3)})  ${percentage.toFixed(2)}%`;
  });
  console.log('');
  console.log('Extracted palette:');
  rows.forEach((row) => console.log(`  ${row}`));
  console.log('');
}

async function main() {
  const options = parseArguments(process.argv);
  if (options.showHelp) {
    console.log('Usage: node scripts/extract-colors.js <imagePath> [--colors=8] [--json]');
    process.exit(0);
  }

  const absolutePath = path.resolve(process.cwd(), options.inputPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Image not found: ${absolutePath}`);
    process.exit(1);
  }

  try {
    const pixels = await extractPixels(absolutePath);
    if (!pixels.length) {
      console.error('No pixel data could be read from the image.');
      process.exit(1);
    }

    const clusters = runKMeans(pixels, options.colors);
    const palette = formatPalette(clusters, pixels.length);

    if (options.outputJson) {
      console.log(JSON.stringify({ image: absolutePath, palette }, null, 2));
    } else {
      console.log(`Image: ${absolutePath}`);
      console.log(`Colors requested: ${options.colors}`);
      printTable(palette);
    }
  } catch (error) {
    console.error('Failed to extract colors:', error.message || error);
    process.exit(1);
  }
}

main();
