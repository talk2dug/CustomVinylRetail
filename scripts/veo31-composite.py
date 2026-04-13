#!/usr/bin/env python3
"""
Veo 3.1 T-Shirt Reveal — Composite Approach v2
1. Gemini generates a plain white shirt (no design)
2. Remove background from design image
3. Composite design onto shirt = END frame
4. Fold the PLAIN shirt (no design) = START frame
5. Veo 3.1 interpolates the unfolding
"""

import os, sys, time, base64, urllib.request, subprocess
from google import genai
from google.genai.types import Image as GenImage, GenerateVideosConfig
from PIL import Image, ImageDraw, ImageFilter
import io
import numpy as np

# Load API key
api_key = None
env_path = '/home/ubuntu/vinylApp/.env'
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            if line.startswith('GEMINI_API_KEY='):
                api_key = line.strip().split('=', 1)[1]
if not api_key:
    print("Missing GEMINI_API_KEY"); sys.exit(1)

client = genai.Client(api_key=api_key)
OUTPUT_DIR = '/tmp/reveal-composite'
WEB_DIR = '/home/ubuntu/vinylApp/web'
os.makedirs(OUTPUT_DIR, exist_ok=True)

DESIGN_URL = sys.argv[1] if len(sys.argv) > 1 else 'https://blueridgecustomco.com/library/80ssimplified/uploads/previews/billandted-1763415407319.jpg'
OUTPUT_NAME = sys.argv[2] if len(sys.argv) > 2 else 'composite'

TARGET_W = 1080
TARGET_H = 1920


def generate_image(prompt):
    """Generate an image with Gemini."""
    response = client.models.generate_content(
        model='gemini-2.5-flash-image',
        contents=prompt,
        config={'response_modalities': ['TEXT', 'IMAGE']},
    )
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith('image/'):
            return part.inline_data.data
    raise Exception("No image in response")


def remove_dark_background(img, threshold=40):
    """Remove dark/black background from an image, making it transparent."""
    img = img.convert('RGBA')
    arr = np.array(img)
    # Pixels where R, G, B are all below threshold = background
    is_dark = (arr[:,:,0] < threshold) & (arr[:,:,1] < threshold) & (arr[:,:,2] < threshold)
    arr[is_dark, 3] = 0  # make transparent
    return Image.fromarray(arr)


def fit_to_portrait(img):
    """Resize/pad image to TARGET_W x TARGET_H (9:16) portrait."""
    img = img.convert('RGBA')
    # Scale to fit width
    scale = TARGET_W / img.width
    new_w = TARGET_W
    new_h = int(img.height * scale)

    if new_h > TARGET_H:
        scale = TARGET_H / img.height
        new_w = int(img.width * scale)
        new_h = TARGET_H

    resized = img.resize((new_w, new_h), Image.LANCZOS)

    # Create portrait canvas with wooden table color (will be covered by shirt mostly)
    canvas = Image.new('RGBA', (TARGET_W, TARGET_H), (139, 119, 101, 255))
    paste_x = (TARGET_W - new_w) // 2
    paste_y = (TARGET_H - new_h) // 2
    canvas.paste(resized, (paste_x, paste_y), resized)
    return canvas


print("=" * 60)
print("  Veo 3.1 Reveal — Composite v2")
print("=" * 60)

# 1. Download design
print("\n[1/6] Downloading design...")
design_bytes = urllib.request.urlopen(DESIGN_URL, timeout=30).read()
design_raw = Image.open(io.BytesIO(design_bytes))
print(f"  Design: {design_raw.size[0]}x{design_raw.size[1]}, {len(design_bytes)//1024}KB")

# Remove dark background
design_clean = remove_dark_background(design_raw, threshold=45)
design_clean.save(os.path.join(OUTPUT_DIR, 'design_clean.png'))
print(f"  Background removed")

# 2. Generate plain white shirt
print("\n[2/6] Generating plain white t-shirt (Gemini)...")
shirt_prompt = (
    "Photorealistic product photography, shot directly from above looking straight down, bird's eye view. "
    "A rustic wooden table with warm brown wood grain fills the entire background edge to edge. "
    "A plain white t-shirt lies completely flat and fully unfolded on the wooden table, perfectly centered. "
    "Both sleeves are fully extended outward to the left and right. "
    "The shirt is completely smooth with no folds, no wrinkles, no creases. "
    "The shirt is completely plain white with absolutely nothing printed on it. "
    "No graphic, no design, no logo, no text. Just a blank white t-shirt on wood. "
    "Vertical portrait 9:16 aspect ratio."
)

shirt_bytes = generate_image(shirt_prompt)
shirt_raw = Image.open(io.BytesIO(shirt_bytes)).convert('RGBA')
shirt_path = os.path.join(OUTPUT_DIR, 'plain_shirt_raw.png')
shirt_raw.save(shirt_path)
print(f"  Raw shirt: {shirt_raw.size[0]}x{shirt_raw.size[1]}, {len(shirt_bytes)//1024}KB")

# Fit to portrait 9:16
shirt_img = fit_to_portrait(shirt_raw)
shirt_img.save(os.path.join(OUTPUT_DIR, 'plain_shirt_portrait.png'))
print(f"  Portrait: {TARGET_W}x{TARGET_H}")

# 3. Composite design onto chest = END frame
print("\n[3/6] Creating END frame (design composited on shirt)...")

# Design placement: centered on chest
# Shirt in portrait: chest area is roughly 30-55% from top
design_w = int(TARGET_W * 0.35)
design_h = int(design_w * design_clean.size[1] / design_clean.size[0])

max_design_h = int(TARGET_H * 0.22)
if design_h > max_design_h:
    design_h = max_design_h
    design_w = int(design_h * design_clean.size[0] / design_clean.size[1])

design_resized = design_clean.resize((design_w, design_h), Image.LANCZOS)

paste_x = (TARGET_W - design_w) // 2
paste_y = int(TARGET_H * 0.32)  # chest area

end_img = shirt_img.copy()
end_img.paste(design_resized, (paste_x, paste_y), design_resized)

# Convert to RGB for final output (no alpha needed)
end_rgb = end_img.convert('RGB')
end_path = os.path.join(OUTPUT_DIR, 'end_frame.png')
end_rgb.save(end_path)
end_bytes = open(end_path, 'rb').read()
print(f"  End frame saved, design at ({paste_x},{paste_y}) size {design_w}x{design_h}")

# 4. Create START frame by folding PLAIN shirt (no design)
print("\n[4/6] Creating START frame (plain shirt folded)...")

# Use the PLAIN shirt (no design) for the fold
plain_rgb = shirt_img.convert('RGB')

# Fold line: roughly at waist level, above where design starts
fold_y = int(TARGET_H * 0.50)

# Take the bottom portion of the plain shirt
bottom = plain_rgb.crop((0, fold_y, TARGET_W, TARGET_H))
bottom_flipped = bottom.transpose(Image.FLIP_TOP_BOTTOM)

# Start with the plain shirt
start_img = plain_rgb.copy()

# Paste flipped bottom on top (this covers the chest where design would be)
flip_h = bottom_flipped.size[1]
paste_top = fold_y - flip_h
if paste_top < 0:
    # Crop the flipped portion if it would go above the image
    bottom_flipped = bottom_flipped.crop((0, -paste_top, TARGET_W, flip_h))
    paste_top = 0

start_img.paste(bottom_flipped, (0, paste_top))

# Add subtle shadow along fold line for realism
shadow_strip = Image.new('RGBA', (TARGET_W, 12), (0, 0, 0, 0))
draw = ImageDraw.Draw(shadow_strip)
for y in range(12):
    alpha = int(50 * (1 - y / 12))
    draw.line([(0, y), (TARGET_W, y)], fill=(0, 0, 0, alpha))
start_rgb = start_img.convert('RGBA')
start_rgb.paste(shadow_strip, (0, fold_y - 6), shadow_strip)
start_rgb = start_rgb.convert('RGB')

start_path = os.path.join(OUTPUT_DIR, 'start_frame.png')
start_rgb.save(start_path)
start_bytes = open(start_path, 'rb').read()
print(f"  Start frame saved, fold at y={fold_y}")

# 5. Send to Veo 3.1
print("\n[5/6] Sending to Veo 3.1...")

veo_prompt = (
    "Overhead bird's eye view, camera looking straight down at a rustic wooden table. "
    "Camera is completely fixed — no movement, no zoom, no pan. "
    "A white t-shirt on the table has its bottom half folded upward, hiding the chest. "
    "The folded fabric slowly and smoothly unfolds downward, dropping flat onto the table, "
    "revealing a colorful printed graphic design on the chest underneath. "
    "Simple, clean, satisfying fabric unfolding motion. The table never changes."
)

operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt=veo_prompt,
    image=GenImage(image_bytes=start_bytes, mime_type="image/png"),
    config=GenerateVideosConfig(
        last_frame=GenImage(image_bytes=end_bytes, mime_type="image/png"),
        aspect_ratio="9:16",
        duration_seconds=8,
    ),
)

poll = 0
while not operation.done:
    time.sleep(15)
    operation = client.operations.get(operation)
    poll += 1
    print(f"  Poll {poll}... ({poll*15}s)")

print(f"  Completed after {poll*15}s")

if not operation.result or not operation.result.generated_videos:
    print("  ERROR: No videos generated")
    sys.exit(1)

video_obj = operation.result.generated_videos[0].video
client.files.download(file=video_obj)
video_path = os.path.join(WEB_DIR, f'tshirt_reveal_{OUTPUT_NAME}.mp4')
video_obj.save(video_path)
print(f"  Video: {video_path} ({os.path.getsize(video_path)//1024}KB)")
print(f"  URL: https://blueridgecustomco.com/tshirt_reveal_{OUTPUT_NAME}.mp4")

# 6. Extract video frames for inspection
print("\n[6/6] Extracting video frames for inspection...")
check_dir = os.path.join(OUTPUT_DIR, 'check')
os.makedirs(check_dir, exist_ok=True)

result = subprocess.run(
    ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', video_path],
    capture_output=True, text=True
)
duration = float(result.stdout.strip())

for i in range(10):
    t = (duration * i) / 10
    out = os.path.join(check_dir, f'frame_{i:02d}.png')
    subprocess.run(['ffmpeg', '-y', '-ss', str(t), '-i', video_path, '-vframes', '1', out], capture_output=True)

print(f"  Extracted 10 frames from {duration:.1f}s video")
print(f"\n{'='*60}")
print(f"  Done!")
print(f"  https://blueridgecustomco.com/tshirt_reveal_{OUTPUT_NAME}.mp4")
print(f"{'='*60}")
