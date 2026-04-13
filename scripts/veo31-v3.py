#!/usr/bin/env python3
"""
Veo 3.1 T-Shirt Reveal — v3
1. Gemini generates a plain white shirt
2. PIL composites the ACTUAL design onto the chest = END frame
3. Gemini edits the end frame to show it folded = START frame
4. Veo 3.1 interpolates
"""

import os, sys, time, base64, urllib.request, subprocess
from google import genai
from google.genai.types import Image as GenImage, GenerateVideosConfig, Part, Blob
from PIL import Image
import io
import numpy as np

# Load API key
api_key = None
with open('/home/ubuntu/vinylApp/.env') as f:
    for line in f:
        if line.startswith('GEMINI_API_KEY='):
            api_key = line.strip().split('=', 1)[1]
if not api_key:
    print("Missing GEMINI_API_KEY"); sys.exit(1)

client = genai.Client(api_key=api_key)
OUTPUT_DIR = '/tmp/reveal-v3'
WEB_DIR = '/home/ubuntu/vinylApp/web'
os.makedirs(OUTPUT_DIR, exist_ok=True)

DESIGN_URL = sys.argv[1] if len(sys.argv) > 1 else 'https://blueridgecustomco.com/library/80ssimplified/uploads/previews/billandted-1763415407319.jpg'
OUTPUT_NAME = sys.argv[2] if len(sys.argv) > 2 else 'v3'


def generate_image(prompt, reference_bytes=None):
    """Generate image, optionally with reference."""
    contents = []
    if reference_bytes:
        contents.append(Part(inline_data=Blob(
            mime_type='image/png',
            data=base64.b64encode(reference_bytes).decode()
        )))
    contents.append(prompt)
    response = client.models.generate_content(
        model='gemini-2.5-flash-image',
        contents=contents,
        config={'response_modalities': ['TEXT', 'IMAGE']},
    )
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith('image/'):
            return part.inline_data.data
    raise Exception("No image in response")


def remove_dark_bg(img, threshold=45):
    """Remove dark background, return RGBA."""
    img = img.convert('RGBA')
    arr = np.array(img)
    is_dark = (arr[:,:,0] < threshold) & (arr[:,:,1] < threshold) & (arr[:,:,2] < threshold)
    arr[is_dark, 3] = 0
    return Image.fromarray(arr)


print("=" * 60)
print("  Veo 3.1 Reveal — v3")
print("=" * 60)

# 1. Download and clean design
print("\n[1/5] Downloading design...")
design_bytes = urllib.request.urlopen(DESIGN_URL, timeout=30).read()
design_raw = Image.open(io.BytesIO(design_bytes))
design_clean = remove_dark_bg(design_raw)
design_clean.save(os.path.join(OUTPUT_DIR, 'design_clean.png'))
print(f"  Design: {design_raw.size[0]}x{design_raw.size[1]}")

# 2. Generate plain shirt + composite design = END frame
print("\n[2/5] Generating plain shirt & compositing design...")
shirt_bytes = generate_image(
    "Photorealistic product photography, shot directly from above, bird's eye view. "
    "A rustic wooden table with warm brown wood grain fills the entire frame. "
    "A plain white t-shirt lies completely flat on the wooden table, perfectly centered. "
    "Both sleeves are extended outward. The shirt is smooth with no folds or wrinkles. "
    "The shirt is plain white — no design, no graphic, no logo, nothing printed on it. "
    "Vertical portrait 9:16 aspect ratio."
)

shirt_img = Image.open(io.BytesIO(shirt_bytes)).convert('RGBA')
W, H = shirt_img.size
print(f"  Shirt: {W}x{H}")

# Composite design
design_w = int(W * 0.35)
design_h = int(design_w * design_clean.size[1] / design_clean.size[0])
max_h = int(H * 0.28)
if design_h > max_h:
    design_h = max_h
    design_w = int(design_h * design_clean.size[0] / design_clean.size[1])

design_resized = design_clean.resize((design_w, design_h), Image.LANCZOS)
paste_x = (W - design_w) // 2
paste_y = int(H * 0.30)

end_img = shirt_img.copy()
end_img.paste(design_resized, (paste_x, paste_y), design_resized)
end_rgb = end_img.convert('RGB')
end_path = os.path.join(OUTPUT_DIR, 'end_frame.png')
end_rgb.save(end_path)
end_bytes = open(end_path, 'rb').read()
print(f"  End frame: design at ({paste_x},{paste_y}), {design_w}x{design_h}")

# 3. Generate start frame — half-folded shirt (best prompt from testing)
print("\n[3/5] Generating START frame (half-folded shirt)...")

start_bytes = generate_image(
    "Photorealistic bird eye view product photo on rustic wooden table. "
    "A white t-shirt lying on the table. The collar and sleeves are visible and spread outward. "
    "But the shirt body is only half its normal length because someone has flipped "
    "the lower half of the fabric up and over the upper half, creating a thick double "
    "layer of white fabric. The shirt looks half as tall as normal, almost square in the body area. "
    "No design or graphic visible. 9:16 portrait."
)
start_path = os.path.join(OUTPUT_DIR, 'start_frame.png')
with open(start_path, 'wb') as f:
    f.write(start_bytes)
print(f"  Start frame: {len(start_bytes)//1024}KB")

# 4. Veo 3.1 interpolation (with rate limit retry)
print("\n[4/5] Sending to Veo 3.1...")
for retry in range(5):
    try:
        operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt=(
        "Overhead bird's eye view, camera fixed looking straight down at a rustic wooden table. "
        "A white t-shirt has its bottom half folded up, hiding a graphic on the chest. "
        "The fold slowly drops downward, the fabric unfolds flat onto the table, smoothly "
        "revealing a colorful printed design on the chest underneath. "
        "Simple, clean unfolding — just the fabric falling flat. "
        "Camera never moves. Table stays the same throughout."
    ),
    image=GenImage(image_bytes=start_bytes, mime_type="image/png"),
    config=GenerateVideosConfig(
        last_frame=GenImage(image_bytes=end_bytes, mime_type="image/png"),
        aspect_ratio="9:16",
        duration_seconds=8,
    ),
)
        break  # success
    except Exception as e:
        if '429' in str(e) and retry < 4:
            wait = 120 * (retry + 1)
            print(f"  Rate limited, waiting {wait}s (retry {retry+1}/5)...")
            time.sleep(wait)
        else:
            raise

poll = 0
while not operation.done:
    time.sleep(15)
    operation = client.operations.get(operation)
    poll += 1
    print(f"  Poll {poll}... ({poll*15}s)")

print(f"  Completed after {poll*15}s")

if not operation.result or not operation.result.generated_videos:
    print("  ERROR: No videos generated"); sys.exit(1)

video_obj = operation.result.generated_videos[0].video
client.files.download(file=video_obj)
video_path = os.path.join(WEB_DIR, f'tshirt_reveal_{OUTPUT_NAME}.mp4')
video_obj.save(video_path)
print(f"  Video: {os.path.getsize(video_path)//1024}KB")
print(f"  URL: https://blueridgecustomco.com/tshirt_reveal_{OUTPUT_NAME}.mp4")

# 5. Extract frames
print("\n[5/5] Extracting frames for inspection...")
check_dir = os.path.join(OUTPUT_DIR, 'check')
os.makedirs(check_dir, exist_ok=True)
dur_str = subprocess.run(
    ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', video_path],
    capture_output=True, text=True
).stdout.strip()
duration = float(dur_str)
for i in range(10):
    t = duration * i / 10
    subprocess.run(['ffmpeg', '-y', '-ss', str(t), '-i', video_path, '-vframes', '1',
                    os.path.join(check_dir, f'f{i:02d}.png')], capture_output=True)

print(f"  10 frames from {duration:.1f}s")
print(f"\nDone! https://blueridgecustomco.com/tshirt_reveal_{OUTPUT_NAME}.mp4")
