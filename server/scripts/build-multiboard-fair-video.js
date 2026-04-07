#!/usr/bin/env node
/**
 * Build Multiboard Fair/Market Display Video
 *
 * Creates a looping slideshow video from the MultiBoard Media folder
 * with marketing text overlays. Designed to play on a screen at
 * craft fairs and markets.
 *
 * Output: 1080x1920 portrait (for vertical TV/tablet) or 1920x1080 landscape
 * Each image shown for ~4 seconds with fade transitions
 * Background music from royalty-free library
 * Text overlays with marketing copy
 *
 * Usage: node build-multiboard-fair-video.js [--landscape] [--duration 4]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG ====================

const { TIKTOK_VIDEOS_DIR, TIKTOK_TIKTOK_MUSIC_DIR } = require('../paths');
const MEDIA_DIR = path.resolve(__dirname, '..', '..', 'MultiBoard Media');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_LIGHT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TEMP_DIR = path.join(TIKTOK_VIDEOS_DIR, 'tmp');

const args = process.argv.slice(2);
const LANDSCAPE = args.includes('--landscape');
const WIDTH = LANDSCAPE ? 1920 : 1080;
const HEIGHT = LANDSCAPE ? 1080 : 1920;
const SLIDE_DURATION = parseInt(args.find((a, i) => args[i - 1] === '--duration') || '4');
const FPS = 30;
const FADE_DURATION = 0.8;

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(TIKTOK_VIDEOS_DIR, { recursive: true });

// ==================== MARKETING SLIDES ====================
// These are text-only slides interleaved between product photos

const MARKETING_SLIDES = [
  {
    type: 'title',
    line1: 'MULTIBOARD',
    line2: 'The Ultimate Wall Organization System',
    line3: '3D Printed Right Here in Asheville, NC'
  },
  {
    type: 'benefit',
    line1: 'ORGANIZE ANYTHING',
    line2: 'Tools  •  Crafts  •  Kitchen  •  Garage',
    line3: 'Office  •  Gaming  •  Workshop',
  },
  {
    type: 'benefit',
    line1: '100% CUSTOMIZABLE',
    line2: 'Every hook, shelf, and bin is',
    line3: '3D printed to fit YOUR space',
  },
  {
    type: 'benefit',
    line1: 'MODULAR DESIGN',
    line2: 'Start small. Expand anytime.',
    line3: 'Tiles snap together seamlessly.',
  },
  {
    type: 'benefit',
    line1: 'MADE IN ASHEVILLE',
    line2: 'Locally designed and printed',
    line3: 'by Blue Ridge Custom Co',
  },
  {
    type: 'benefit',
    line1: 'BUILT TO LAST',
    line2: 'Industrial-strength PETG plastic',
    line3: 'Holds heavy tools with bolt-lock mounts',
  },
  {
    type: 'cta',
    line1: 'READY TO GET ORGANIZED?',
    line2: 'Talk to us today!',
    line3: 'BlueRidgeCustomCo.com'
  }
];

// ==================== IMAGE CATEGORIZATION ====================
// Group photos by what they show for best narrative flow

const IMAGE_ORDER = [
  // Open with the hero/fair display shots
  '023t8bffz2yhhq7fapcg9opcavd5.jpg',  // market display with shelves
  '6u964lem6xi7t57vy6y4lgbpkjz5.jpg',  // market display keychains
  // Workshops & garages
  'MultiBoard Media.jpeg',              // tool wall (hero shot)
  'IMG_0654.jpg',                       // colorful tool wall orange/blue
  'IMG_4225.jpeg',                      // red milwaukee tool wall
  'IMG_7243.jpeg',                      // long garage workbench
  '1000150858.jpg',                     // full workshop with 3D printers
  'IMG_1719.jpeg',                      // workbench with tools lit
  // Craft & art supplies
  '20260208_203841.jpg',                // art supplies galeria paints
  's7ew39savqy958nzfv826v6gn43a.jpg',   // paint & model supplies wall
  '970tz5qss5jtwn32hqphqrd4cu7m.jpg',   // paint studio workspace
  // Small/desktop setups
  '20260307_160942.jpg',                // small desktop with pliers/paints
  'IMG_5757.jpeg',                      // 3D printer tool station
  // Gaming & lifestyle
  'IMG_3335.jpg',                       // gaming setup PS5 Switch
  // Kitchen & pantry
  'pea39utu4ku6h94h7zuzgkujlukq.jpg',  // pantry snack organization
  // Specialty setups
  'u87myn8l1ebft312lm71ve6gg9eg.jpg',   // RV/small space
  'WhatsApp Image 2026-01-20 at 10.32.38 (1).jpeg', // neon backlit setup
  '51735f68-79dd-4a2b-8dba-e1dee292f1f8.jpg', // black/yellow shipping wall
];

// Remaining images (not explicitly ordered — append at end)
const allImages = fs.readdirSync(MEDIA_DIR)
  .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
  .sort();

const orderedImages = [
  ...IMAGE_ORDER.filter(f => fs.existsSync(path.join(MEDIA_DIR, f))),
  ...allImages.filter(f => !IMAGE_ORDER.includes(f))
];

console.log(`Found ${orderedImages.length} images`);

// ==================== BUILD SLIDE FRAMES ====================

/**
 * Create a text-only slide as a PNG
 */
function createTextSlide(slideData, outputPath) {
  const bg = 'black';
  let drawCommands = [];

  if (slideData.type === 'title') {
    // Big title slide
    drawCommands.push(
      `drawtext=fontfile='${FONT}':text='${esc(slideData.line1)}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h*0.35)`,
      `drawtext=fontfile='${FONT_LIGHT}':text='${esc(slideData.line2)}':fontcolor=#cccccc:fontsize=36:x=(w-text_w)/2:y=(h*0.48)`,
    );
    if (slideData.line3) {
      drawCommands.push(
        `drawtext=fontfile='${FONT_LIGHT}':text='${esc(slideData.line3)}':fontcolor=#4fc3f7:fontsize=30:x=(w-text_w)/2:y=(h*0.56)`
      );
    }
  } else if (slideData.type === 'cta') {
    drawCommands.push(
      `drawtext=fontfile='${FONT}':text='${esc(slideData.line1)}':fontcolor=#4fc3f7:fontsize=52:x=(w-text_w)/2:y=(h*0.32)`,
      `drawtext=fontfile='${FONT_LIGHT}':text='${esc(slideData.line2)}':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=(h*0.45)`,
    );
    if (slideData.line3) {
      drawCommands.push(
        `drawtext=fontfile='${FONT}':text='${esc(slideData.line3)}':fontcolor=#ffb74d:fontsize=36:x=(w-text_w)/2:y=(h*0.58)`
      );
    }
  } else {
    // Benefit slide
    drawCommands.push(
      `drawtext=fontfile='${FONT}':text='${esc(slideData.line1)}':fontcolor=#4fc3f7:fontsize=56:x=(w-text_w)/2:y=(h*0.35)`,
      `drawtext=fontfile='${FONT_LIGHT}':text='${esc(slideData.line2)}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h*0.48)`
    );
    if (slideData.line3) {
      drawCommands.push(
        `drawtext=fontfile='${FONT_LIGHT}':text='${esc(slideData.line3)}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h*0.54)`
      );
    }
  }

  const filter = drawCommands.join(',');
  const cmd = `ffmpeg -y -f lavfi -i color=c=${bg}:s=${WIDTH}x${HEIGHT}:d=1 -vframes 1 -vf "${filter}" "${outputPath}"`;
  execSync(cmd, { timeout: 15000, stdio: 'pipe' });
}

/**
 * Create an image slide — scale/crop to fill frame with Ken Burns effect
 */
function createImageSlide(imagePath, outputPath, index) {
  // Scale image to fill frame, center crop
  const targetRatio = WIDTH / HEIGHT;

  // Determine zoom direction for subtle Ken Burns
  const zoomStart = 1.0;
  const zoomEnd = 1.08;
  const frames = SLIDE_DURATION * FPS;

  const cmd = [
    'ffmpeg', '-y',
    '-loop', '1', '-i', `"${imagePath}"`,
    '-t', SLIDE_DURATION,
    '-vf', `"scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2},zoompan=z='${zoomStart}+(${zoomEnd}-${zoomStart})*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}"`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-an', '-r', FPS,
    `"${outputPath}"`
  ].join(' ');

  execSync(cmd, { timeout: 30000, stdio: 'pipe' });
}

function esc(text) {
  return text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

// ==================== MAIN BUILD ====================

async function build() {
  console.log(`Building Multiboard fair video (${WIDTH}x${HEIGHT}, ${SLIDE_DURATION}s per slide)...`);

  // Interleave: title, 3 images, benefit, 3 images, benefit, ...
  const sequence = [];
  let imgIndex = 0;
  const imagesPerGroup = 3;

  // Start with title
  sequence.push({ type: 'text', data: MARKETING_SLIDES[0] });

  // Alternate between image groups and text slides
  let textIndex = 1;
  while (imgIndex < orderedImages.length) {
    // Add a group of images
    for (let i = 0; i < imagesPerGroup && imgIndex < orderedImages.length; i++) {
      sequence.push({ type: 'image', file: orderedImages[imgIndex++] });
    }
    // Add next text slide if available
    if (textIndex < MARKETING_SLIDES.length) {
      sequence.push({ type: 'text', data: MARKETING_SLIDES[textIndex++] });
    }
  }

  // End with remaining text slides
  while (textIndex < MARKETING_SLIDES.length) {
    sequence.push({ type: 'text', data: MARKETING_SLIDES[textIndex++] });
  }

  console.log(`Sequence: ${sequence.length} slides (${sequence.filter(s => s.type === 'image').length} images, ${sequence.filter(s => s.type === 'text').length} text)`);

  // Generate individual slide videos
  const slidePaths = [];
  for (let i = 0; i < sequence.length; i++) {
    const slide = sequence[i];
    const slideFile = path.join(TEMP_DIR, `fair-slide-${String(i).padStart(3, '0')}.mp4`);
    process.stdout.write(`  Slide ${i + 1}/${sequence.length}: `);

    if (slide.type === 'text') {
      const pngFile = path.join(TEMP_DIR, `fair-text-${i}.png`);
      createTextSlide(slide.data, pngFile);
      // Convert PNG to video
      const dur = slide.data.type === 'title' ? SLIDE_DURATION + 1 : SLIDE_DURATION;
      execSync(`ffmpeg -y -loop 1 -i "${pngFile}" -t ${dur} -c:v libx264 -preset fast -crf 23 -r ${FPS} -pix_fmt yuv420p -an "${slideFile}"`, { timeout: 15000, stdio: 'pipe' });
      try { fs.unlinkSync(pngFile); } catch (_) {}
      console.log(`text: "${slide.data.line1}" (${dur}s)`);
    } else {
      const imgPath = path.join(MEDIA_DIR, slide.file);
      createImageSlide(imgPath, slideFile, i);
      console.log(`image: ${slide.file}`);
    }

    slidePaths.push(slideFile);
  }

  // Concat all slides with crossfade
  console.log('Concatenating slides...');
  const concatFile = path.join(TEMP_DIR, 'fair-concat.txt');
  fs.writeFileSync(concatFile, slidePaths.map(p => `file '${p}'`).join('\n'));

  const concatVideoPath = path.join(TEMP_DIR, 'fair-concat.mp4');
  execSync([
    'ffmpeg', '-y',
    '-f', 'concat', '-safe', '0',
    '-i', `"${concatFile}"`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-an', '-movflags', '+faststart',
    `"${concatVideoPath}"`
  ].join(' '), { timeout: 300000, stdio: 'pipe' });

  // Add background music
  console.log('Adding background music...');
  const musicFiles = fs.readdirSync(TIKTOK_MUSIC_DIR).filter(f => f.endsWith('.ogg'));
  // Pick a chill/upbeat track
  const musicTrack = path.join(TIKTOK_MUSIC_DIR, musicFiles[Math.floor(Math.random() * musicFiles.length)]);

  const videoDuration = parseFloat(
    execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${concatVideoPath}"`, { encoding: 'utf8' }).trim()
  );

  const fadeDur = 3;
  const orientation = LANDSCAPE ? 'landscape' : 'portrait';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFilename = `multiboard-fair-${orientation}-${timestamp}.mp4`;
  const outputPath = path.join(TIKTOK_VIDEOS_DIR, outputFilename);

  execSync([
    'ffmpeg', '-y',
    '-i', `"${concatVideoPath}"`,
    '-stream_loop', '-1', '-i', `"${musicTrack}"`,
    '-filter_complex',
    `"[1:a]atrim=0:${videoDuration.toFixed(1)},afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${(videoDuration - fadeDur).toFixed(1)}:d=${fadeDur},volume=0.7[music];[music]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]"`,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    `"${outputPath}"`
  ].join(' '), { timeout: 300000, stdio: 'pipe' });

  // Cleanup
  console.log('Cleaning up temp files...');
  for (const p of slidePaths) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.unlinkSync(concatFile); } catch (_) {}
  try { fs.unlinkSync(concatVideoPath); } catch (_) {}

  const finalSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log('========================================');
  console.log(`  DONE: ${outputFilename}`);
  console.log(`  Duration: ${Math.round(videoDuration)}s`);
  console.log(`  Size: ${finalSize} MB`);
  console.log(`  Resolution: ${WIDTH}x${HEIGHT} (${orientation})`);
  console.log(`  Music: ${path.basename(musicTrack)}`);
  console.log(`  Slides: ${sequence.length} (${orderedImages.length} photos + ${MARKETING_SLIDES.length} text)`);
  console.log(`  Path: ${outputPath}`);
  console.log(`  URL: https://blueridgecustomco.com/api/tiktok-videos/${outputFilename}`);
  console.log('========================================');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
