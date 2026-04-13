#!/usr/bin/env python3
"""
T-Shirt Reveal — Veo 3.1 First+Last Frame Interpolation
Blue Ridge Custom Co — TikTok Content Pipeline

1. Gemini generates START frame (folded shirt, no design)
2. Gemini generates END frame (flat shirt with design from reference)
3. Veo 3.1 interpolates smooth unfolding motion between them
"""

import os, sys, time, urllib.request, subprocess, base64
from google import genai
from google.genai.types import Image, GenerateVideosConfig, Part, Blob

# ─── CONFIG ──────────────────────────────────────────────────────────────────

API_KEY = None
# Try to load from .env
env_path = '/home/ubuntu/vinylApp/.env'
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            if line.startswith('GEMINI_API_KEY='):
                API_KEY = line.strip().split('=', 1)[1]

if not API_KEY:
    # Try dotenv-style
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path)
        API_KEY = os.environ.get('GEMINI_API_KEY')
    except:
        pass

if not API_KEY:
    print("Missing GEMINI_API_KEY")
    sys.exit(1)

client = genai.Client(api_key=API_KEY)
OUTPUT_DIR = '/tmp/reveal-veo31'
WEB_DIR = '/home/ubuntu/vinylApp/web'
os.makedirs(OUTPUT_DIR, exist_ok=True)

BASE_SETUP = (
    "Shot directly overhead, perfectly flat lay, centered on a clean rustic wooden table surface. "
    "Bright, even studio lighting, no shadows, no perspective distortion. "
    "Photorealistic product photography style. "
    "Vertical frame, portrait orientation. "
)

# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    design_url = sys.argv[1] if len(sys.argv) > 1 else None
    output_name = sys.argv[2] if len(sys.argv) > 2 else 'reveal'

    if not design_url:
        print("Usage: python3 veo31-reveal.py <design-image-url> [output-name]")
        sys.exit(1)

    print("=" * 60)
    print("  BRCC T-Shirt Reveal — Veo 3.1 Interpolation")
    print(f"  Design: {design_url.split('/')[-1]}")
    print("=" * 60)

    # Download design image
    print("\n[1/4] Downloading design image...")
    design_bytes = urllib.request.urlopen(design_url, timeout=30).read()
    design_path = os.path.join(OUTPUT_DIR, 'design_reference.jpg')
    with open(design_path, 'wb') as f:
        f.write(design_bytes)
    print(f"  Design: {len(design_bytes)//1024}KB")

    # Generate START frame — folded shirt, no design visible
    print("\n[2/4] Generating START frame (folded shirt)...")
    start_prompt = (
        BASE_SETUP +
        "A white t-shirt is laid on the table with both sleeves extended outward. "
        "The bottom half of the shirt has been folded upward — the bottom hem is folded up "
        "to meet the neckline, creating a visible horizontal fold line across the middle. "
        "The lower fabric layer is on top, completely hiding the chest area underneath. "
        "You can see the neckline at the top, sleeves on both sides, and a thick folded "
        "double-layer of white fabric where the chest would be. No graphic is visible because "
        "the fold covers it entirely. The shirt is clearly folded in half, not flat."
    )

    start_response = client.models.generate_content(
        model='gemini-2.5-flash-image',
        contents=start_prompt,
        config={
            'response_modalities': ['TEXT', 'IMAGE'],
        }
    )

    start_bytes = None
    for part in start_response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith('image/'):
            start_bytes = part.inline_data.data
            break

    if not start_bytes:
        print("  Failed to generate start frame")
        sys.exit(1)

    start_path = os.path.join(OUTPUT_DIR, 'start_frame.png')
    with open(start_path, 'wb') as f:
        f.write(start_bytes)
    print(f"  Start frame: {len(start_bytes)//1024}KB")

    # Generate END frame — flat shirt with design from reference
    print("\n[3/4] Generating END frame (design revealed)...")
    import hashlib
    hex_id = hashlib.md5(design_bytes[:256]).hexdigest()[:8].upper()

    end_prompt = (
        BASE_SETUP +
        "A white t-shirt lies completely flat and fully unfolded, perfectly centered. "
        "Both sleeves are extended. The shirt is smooth with no folds. "
        f"The design from the reference image (product SKU {hex_id}) graphic is fully revealed "
        "on the chest, centered and sharp. This is the money shot — the full product reveal."
    )

    end_response = client.models.generate_content(
        model='gemini-2.5-flash-image',
        contents=[
            Part(inline_data=Blob(mime_type='image/jpeg', data=base64.b64encode(design_bytes).decode())),
            end_prompt,
        ],
        config={
            'response_modalities': ['TEXT', 'IMAGE'],
        }
    )

    end_bytes = None
    for part in end_response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.mime_type.startswith('image/'):
            end_bytes = part.inline_data.data
            break

    if not end_bytes:
        print("  Failed to generate end frame")
        sys.exit(1)

    end_path = os.path.join(OUTPUT_DIR, 'end_frame.png')
    with open(end_path, 'wb') as f:
        f.write(end_bytes)
    print(f"  End frame: {len(end_bytes)//1024}KB")

    # Veo 3.1 — interpolate between start and end frames
    print("\n[4/4] Generating video (Veo 3.1 interpolation)...")
    print("  This takes 2-5 minutes...")

    operation = client.models.generate_videos(
        model="veo-3.1-generate-preview",
        prompt="Overhead bird's eye view, fixed camera. A white t-shirt on a wooden table has its bottom half folded up. The fold slowly drops down and unfolds flat, revealing a colorful printed graphic on the chest underneath. The shirt goes from folded in half to lying completely flat. Smooth, slow, satisfying unfolding motion. Product photography.",
        image=Image(image_bytes=start_bytes, mime_type="image/png"),
        config=GenerateVideosConfig(
            last_frame=Image(image_bytes=end_bytes, mime_type="image/png"),
            aspect_ratio="9:16",
            duration_seconds=8,
        ),
    )

    # Poll for completion
    poll_count = 0
    while not operation.done:
        time.sleep(15)
        operation = client.operations.get(operation)
        poll_count += 1
        print(f"  Polling {poll_count}... ({poll_count * 15}s)", end='\r')

    print(f"\n  Completed after {poll_count * 15}s")

    if not operation.result or not operation.result.generated_videos:
        print("  No videos generated")
        print(f"  Operation: {operation}")
        sys.exit(1)

    # Download and save videos
    for i, video in enumerate(operation.result.generated_videos):
        client.files.download(file=video.video)
        out_path = os.path.join(WEB_DIR, f"tshirt_reveal_{output_name}_{i}.mp4")
        video.video.save(out_path)
        file_size = os.path.getsize(out_path)
        print(f"  Video {i}: {out_path} ({file_size//1024}KB)")
        print(f"  URL: https://blueridgecustomco.com/tshirt_reveal_{output_name}_{i}.mp4")

    print("\nDone!")

if __name__ == '__main__':
    main()
