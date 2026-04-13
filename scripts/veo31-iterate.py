#!/usr/bin/env python3
"""
Iterate on Veo 3.1 t-shirt reveal - generate frames, inspect, send to Veo.
"""

import os, sys, time, base64, urllib.request, hashlib
from google import genai
from google.genai.types import Image, GenerateVideosConfig, Part, Blob

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
OUTPUT_DIR = '/tmp/reveal-iterate'
WEB_DIR = '/home/ubuntu/vinylApp/web'
os.makedirs(OUTPUT_DIR, exist_ok=True)

DESIGN_URL = sys.argv[1] if len(sys.argv) > 1 else 'https://blueridgecustomco.com/library/80ssimplified/uploads/previews/billandted-1763415407319.jpg'
OUTPUT_NAME = sys.argv[2] if len(sys.argv) > 2 else 'reveal_iter'
ATTEMPT = int(sys.argv[3]) if len(sys.argv) > 3 else 1

def generate_image(prompt, reference_bytes=None):
    """Generate an image with Gemini, optionally with a reference image."""
    contents = []
    if reference_bytes:
        contents.append(Part(inline_data=Blob(mime_type='image/jpeg', data=base64.b64encode(reference_bytes).decode())))
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

def extract_video_frames(video_path, output_dir, count=8):
    """Extract evenly-spaced frames from a video for inspection."""
    import subprocess
    os.makedirs(output_dir, exist_ok=True)
    # Get duration
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', video_path],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())

    frames = []
    for i in range(count):
        t = (duration * i) / count
        out_path = os.path.join(output_dir, f'check_{i:02d}.png')
        subprocess.run(
            ['ffmpeg', '-y', '-ss', str(t), '-i', video_path, '-vframes', '1', out_path],
            capture_output=True
        )
        if os.path.exists(out_path):
            frames.append(out_path)
    return frames, duration

# ─── MAIN ────────────────────────────────────────────────────────────────────

print(f"=== Veo 3.1 Reveal — Attempt {ATTEMPT} ===")

# Download design
print("[1] Downloading design...")
design_bytes = urllib.request.urlopen(DESIGN_URL, timeout=30).read()
hex_id = hashlib.md5(design_bytes[:256]).hexdigest()[:8].upper()
print(f"  Design: {len(design_bytes)//1024}KB")

# Generate START frame
print("[2] Generating START frame (half-folded shirt)...")
start_prompt = (
    "Photorealistic product photography, shot directly from above, bird's eye view. "
    "A rustic wooden table surface fills the entire background. "
    "A white t-shirt is laid out on the wooden table. The sleeves are extended outward to the left and right. "
    "The bottom half of the shirt body has been folded upward — the bottom hem is folded up and rests "
    "near the neckline, creating a horizontal fold across the middle of the torso area. "
    "This fold creates a visible double layer of white fabric that completely covers and hides "
    "the chest area where a graphic would normally be. "
    "The shirt collar/neckline is visible at the top. Both sleeves extend outward. "
    "Below the fold you can see the wooden table. "
    "No graphic, no design, no print is visible anywhere. "
    "Vertical portrait orientation 9:16."
)

start_bytes = generate_image(start_prompt)
start_path = os.path.join(OUTPUT_DIR, f'start_{ATTEMPT}.png')
with open(start_path, 'wb') as f:
    f.write(start_bytes)
print(f"  Start: {len(start_bytes)//1024}KB -> {start_path}")

# Generate END frame
print("[3] Generating END frame (flat shirt with design)...")
end_prompt = (
    "Photorealistic product photography, shot directly from above, bird's eye view. "
    "A rustic wooden table surface fills the entire background. "
    "A white t-shirt lies completely flat and fully unfolded on the wooden table, perfectly centered. "
    "Both sleeves are fully extended outward to left and right. "
    "The shirt is completely smooth with no folds or wrinkles at all. "
    f"The design from the reference image (SKU {hex_id}) is printed on the center chest area "
    "of the shirt. The design is clearly visible, centered, and sharp. "
    "Vertical portrait orientation 9:16."
)

end_bytes = generate_image(end_prompt, reference_bytes=design_bytes)
end_path = os.path.join(OUTPUT_DIR, f'end_{ATTEMPT}.png')
with open(end_path, 'wb') as f:
    f.write(end_bytes)
print(f"  End: {len(end_bytes)//1024}KB -> {end_path}")

# Send to Veo 3.1
print("[4] Sending to Veo 3.1...")
veo_prompt = (
    "Overhead bird's eye view looking straight down at a wooden table. Camera is completely fixed and does not move. "
    "A white t-shirt has its bottom half folded up. The fold slowly and smoothly drops downward, "
    "unfolding the shirt to lie completely flat. As the fold opens, a colorful printed graphic "
    "on the chest is gradually revealed underneath. "
    "Simple, clean unfolding motion — the fabric just folds down. No hands. No camera movement. "
    "The wooden table background stays the same throughout."
)

operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt=veo_prompt,
    image=Image(image_bytes=start_bytes, mime_type="image/png"),
    config=GenerateVideosConfig(
        last_frame=Image(image_bytes=end_bytes, mime_type="image/png"),
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

# Save video
video_obj = operation.result.generated_videos[0].video
client.files.download(file=video_obj)
video_path = os.path.join(WEB_DIR, f'tshirt_reveal_{OUTPUT_NAME}_{ATTEMPT}.mp4')
video_obj.save(video_path)
print(f"  Video: {video_path} ({os.path.getsize(video_path)//1024}KB)")
print(f"  URL: https://blueridgecustomco.com/tshirt_reveal_{OUTPUT_NAME}_{ATTEMPT}.mp4")

# Extract frames for inspection
print("[5] Extracting video frames for inspection...")
check_dir = os.path.join(OUTPUT_DIR, f'check_{ATTEMPT}')
frames, duration = extract_video_frames(video_path, check_dir)
print(f"  Extracted {len(frames)} frames from {duration:.1f}s video")
for f in frames:
    print(f"  -> {f}")

print(f"\n=== Attempt {ATTEMPT} complete ===")
