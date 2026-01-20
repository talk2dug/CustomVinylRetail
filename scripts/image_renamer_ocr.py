#!/usr/bin/env python3
"""
OCR-Powered Image Renamer
Extracts text from images using Tesseract OCR and renames files accordingly.
Free and runs locally - no API credits needed!
"""

import os
import sys
import argparse
import re
from pathlib import Path
from datetime import datetime
import json

try:
    import pytesseract
    from PIL import Image, ImageFilter, ImageOps
except ImportError:
    print("Missing required libraries. Install with:")
    print("  pip install pytesseract pillow")
    print("\nAlso install Tesseract OCR:")
    print("  Ubuntu/Debian: sudo apt install tesseract-ocr")
    print("  macOS: brew install tesseract")
    print("  Windows: Download from https://github.com/UB-Mannheim/tesseract/wiki")
    sys.exit(1)

# Supported image extensions
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'}


def sanitize_filename(name: str) -> str:
    """Convert extracted text to a valid filename."""
    # Remove or replace invalid characters
    name = re.sub(r'[<>:"/\\|?*\n\r\t]', '', name)
    # Replace spaces and multiple underscores
    name = re.sub(r'\s+', '_', name)
    name = re.sub(r'_+', '_', name)
    # Remove leading/trailing underscores and dots
    name = name.strip('_.')
    # Limit length
    name = name[:100]
    return name


def get_unique_filename(directory: str, base_name: str, extension: str) -> str:
    """Generate a unique filename if one already exists."""
    full_path = os.path.join(directory, f"{base_name}{extension}")
    if not os.path.exists(full_path):
        return f"{base_name}{extension}"
    
    counter = 1
    while True:
        new_name = f"{base_name}_{counter}{extension}"
        full_path = os.path.join(directory, new_name)
        if not os.path.exists(full_path):
            return new_name
        counter += 1


def preprocess_image(image: Image.Image, mode: str = 'auto') -> list[Image.Image]:
    """
    Preprocess image to improve OCR accuracy.
    Returns multiple variants to try.
    """
    variants = []
    
    # Convert to RGB if necessary
    if image.mode in ('RGBA', 'P'):
        # Handle transparency - create white background
        background = Image.new('RGB', image.size, (255, 255, 255))
        if image.mode == 'P':
            image = image.convert('RGBA')
        background.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
        image = background
    elif image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Original (converted to RGB)
    variants.append(image)
    
    # Grayscale
    gray = ImageOps.grayscale(image)
    variants.append(gray)
    
    # High contrast grayscale
    contrast = ImageOps.autocontrast(gray, cutoff=2)
    variants.append(contrast)
    
    # Inverted (for white text on dark background - common in band logos)
    inverted = ImageOps.invert(gray)
    variants.append(inverted)
    
    # Inverted with contrast
    inverted_contrast = ImageOps.autocontrast(inverted, cutoff=2)
    variants.append(inverted_contrast)
    
    # Scaled up (helps with small text)
    if image.width < 500 or image.height < 500:
        scale = max(500 / image.width, 500 / image.height)
        new_size = (int(image.width * scale), int(image.height * scale))
        scaled = image.resize(new_size, Image.Resampling.LANCZOS)
        variants.append(scaled)
        variants.append(ImageOps.invert(ImageOps.grayscale(scaled)))
    
    # Binarized (black and white only)
    threshold = 128
    binarized = gray.point(lambda x: 255 if x > threshold else 0, mode='1')
    variants.append(binarized)
    
    return variants


def extract_text_from_image(image_path: str, preprocess: bool = True) -> tuple[str, float]:
    """
    Extract text from image using Tesseract OCR.
    Returns the best text found and a confidence score.
    """
    image = Image.open(image_path)
    
    if preprocess:
        variants = preprocess_image(image)
    else:
        variants = [image]
    
    best_text = ""
    best_confidence = 0
    
    # Tesseract configs to try
    configs = [
        '--psm 6',  # Assume uniform block of text
        '--psm 7',  # Treat as single text line
        '--psm 8',  # Treat as single word
        '--psm 11', # Sparse text
        '--psm 3',  # Fully automatic
    ]
    
    for variant in variants:
        for config in configs:
            try:
                # Get detailed data including confidence
                data = pytesseract.image_to_data(variant, config=config, output_type=pytesseract.Output.DICT)
                
                # Filter by confidence and extract text
                words = []
                confidences = []
                for i, conf in enumerate(data['conf']):
                    if int(conf) > 30:  # Minimum confidence threshold
                        text = data['text'][i].strip()
                        if text and len(text) > 1:  # Skip single characters
                            words.append(text)
                            confidences.append(int(conf))
                
                if words:
                    combined_text = ' '.join(words)
                    avg_confidence = sum(confidences) / len(confidences)
                    
                    # Prefer longer text with good confidence
                    score = avg_confidence * (1 + len(combined_text) / 50)
                    
                    if score > best_confidence:
                        best_text = combined_text
                        best_confidence = score
                        
            except Exception:
                continue
    
    return best_text, best_confidence


def clean_band_name(text: str) -> str:
    """
    Clean up extracted text to get a usable band name.
    """
    # Remove common noise words
    noise = {'the', 'band', 'logo', 'official', 'music', 'rock', 'metal'}
    
    words = text.split()
    # Only filter noise if we have multiple words
    if len(words) > 1:
        words = [w for w in words if w.lower() not in noise]
    
    result = ' '.join(words)
    
    # Title case for nicer filenames
    result = result.title()
    
    return result


def process_images(
    folder_path: str,
    dry_run: bool = False,
    recursive: bool = False,
    min_confidence: float = 40,
    clean_names: bool = True,
    preprocess: bool = True
) -> list[dict]:
    """Process all images in a folder."""
    
    results = []
    folder = Path(folder_path)
    
    if not folder.exists():
        print(f"Error: Folder '{folder_path}' does not exist.")
        sys.exit(1)
    
    # Get list of images
    if recursive:
        image_files = [f for f in folder.rglob('*') if f.suffix.lower() in IMAGE_EXTENSIONS]
    else:
        image_files = [f for f in folder.iterdir() if f.suffix.lower() in IMAGE_EXTENSIONS]
    
    if not image_files:
        print(f"No images found in '{folder_path}'")
        return results
    
    print(f"Found {len(image_files)} images to process...")
    print("-" * 60)
    
    for i, image_path in enumerate(image_files, 1):
        print(f"[{i}/{len(image_files)}] Processing: {image_path.name}")
        
        try:
            # Extract text from image
            extracted_text, confidence = extract_text_from_image(
                str(image_path), 
                preprocess=preprocess
            )
            
            if not extracted_text or confidence < min_confidence:
                print(f"  ⚠ No text found (confidence: {confidence:.1f}), skipping")
                results.append({
                    'original': str(image_path),
                    'new': None,
                    'extracted_text': extracted_text,
                    'confidence': confidence,
                    'status': 'skipped',
                    'reason': 'low confidence or no text'
                })
                continue
            
            # Clean up the text
            if clean_names:
                cleaned_text = clean_band_name(extracted_text)
            else:
                cleaned_text = extracted_text
            
            new_base_name = sanitize_filename(cleaned_text)
            
            if not new_base_name:
                print(f"  ⚠ Could not create valid filename, skipping")
                results.append({
                    'original': str(image_path),
                    'new': None,
                    'extracted_text': extracted_text,
                    'confidence': confidence,
                    'status': 'skipped',
                    'reason': 'invalid filename'
                })
                continue
            
            # Generate unique filename
            new_filename = get_unique_filename(
                str(image_path.parent),
                new_base_name,
                image_path.suffix.lower()
            )
            new_path = image_path.parent / new_filename
            
            print(f"  Text found: \"{extracted_text}\" (confidence: {confidence:.1f})")
            print(f"  → {new_filename}")
            
            if not dry_run:
                os.rename(image_path, new_path)
                print(f"  ✓ Renamed successfully")
            else:
                print(f"  (dry run - no changes made)")
            
            results.append({
                'original': str(image_path),
                'new': str(new_path),
                'extracted_text': extracted_text,
                'cleaned_name': cleaned_text,
                'confidence': confidence,
                'status': 'success' if not dry_run else 'dry_run'
            })
            
        except Exception as e:
            print(f"  ✗ Error: {str(e)}")
            results.append({
                'original': str(image_path),
                'new': None,
                'status': 'error',
                'reason': str(e)
            })
    
    return results


def main():
    parser = argparse.ArgumentParser(
        description='OCR-powered image renamer - extracts text from images and renames files',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Rename band logos (dry run first to preview)
  python image_renamer_ocr.py ./logos --dry-run
  
  # Actually rename the files
  python image_renamer_ocr.py ./logos
  
  # Lower confidence threshold for stylized text
  python image_renamer_ocr.py ./logos --min-confidence 25
  
  # Skip preprocessing (faster but less accurate)
  python image_renamer_ocr.py ./logos --no-preprocess
  
  # Process subfolders
  python image_renamer_ocr.py ./images --recursive
  
  # Keep raw extracted text (no cleaning)
  python image_renamer_ocr.py ./logos --raw

Requirements:
  pip install pytesseract pillow
  
  Also install Tesseract OCR:
    Ubuntu/Debian: sudo apt install tesseract-ocr
    macOS: brew install tesseract
    Windows: https://github.com/UB-Mannheim/tesseract/wiki
        """
    )
    
    parser.add_argument('folder', help='Path to folder containing images')
    parser.add_argument('--dry-run', '-d',
                        action='store_true',
                        help='Preview changes without renaming')
    parser.add_argument('--recursive', '-r',
                        action='store_true',
                        help='Process subfolders recursively')
    parser.add_argument('--min-confidence', '-c',
                        type=float, default=40,
                        help='Minimum OCR confidence (0-100, default: 40)')
    parser.add_argument('--raw',
                        action='store_true',
                        help='Use raw extracted text without cleaning')
    parser.add_argument('--no-preprocess',
                        action='store_true',
                        help='Skip image preprocessing (faster but less accurate)')
    parser.add_argument('--output-log', '-o',
                        help='Save results to JSON log file')
    
    args = parser.parse_args()
    
    # Verify Tesseract is installed
    try:
        pytesseract.get_tesseract_version()
    except pytesseract.TesseractNotFoundError:
        print("Error: Tesseract OCR is not installed or not in PATH")
        print("\nInstall Tesseract:")
        print("  Ubuntu/Debian: sudo apt install tesseract-ocr")
        print("  macOS: brew install tesseract")
        print("  Windows: https://github.com/UB-Mannheim/tesseract/wiki")
        sys.exit(1)
    
    print("OCR Image Renamer (Tesseract)")
    print(f"Folder: {args.folder}")
    print(f"Min confidence: {args.min_confidence}")
    print(f"Preprocessing: {'Off' if args.no_preprocess else 'On'}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print("=" * 60)
    
    results = process_images(
        args.folder,
        args.dry_run,
        args.recursive,
        args.min_confidence,
        clean_names=not args.raw,
        preprocess=not args.no_preprocess
    )
    
    # Summary
    print("=" * 60)
    success = sum(1 for r in results if r['status'] in ('success', 'dry_run'))
    errors = sum(1 for r in results if r['status'] == 'error')
    skipped = sum(1 for r in results if r['status'] == 'skipped')
    
    print(f"Summary: {success} successful, {errors} errors, {skipped} skipped")
    
    if skipped > 0:
        print(f"\nTip: For stylized logos, try lowering --min-confidence to 25 or 30")
    
    # Save log if requested
    if args.output_log:
        log_data = {
            'timestamp': datetime.now().isoformat(),
            'folder': args.folder,
            'min_confidence': args.min_confidence,
            'dry_run': args.dry_run,
            'results': results
        }
        with open(args.output_log, 'w') as f:
            json.dump(log_data, f, indent=2)
        print(f"Log saved to: {args.output_log}")


if __name__ == '__main__':
    main()
