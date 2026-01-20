/**
 * Studio3 Parser for Silhouette .studio3 files
 * Extracts images, cut paths, and metadata
 * 
 * Usage:
 *   const parser = new Studio3Parser('/path/to/file.studio3');
 *   const data = await parser.parse();
 *   // data.images - array of extracted PNG buffers
 *   // data.paths - array of cut path coordinate arrays
 *   // data.metadata - document metadata
 */

const fs = require('fs').promises;
const path = require('path');

class Studio3Parser {
  constructor(filepath) {
    this.filepath = filepath;
    this.data = null;
  }

  async load() {
    this.data = await fs.readFile(this.filepath);
    this._validateHeader();
    return this;
  }

  _validateHeader() {
    const header = this.data.slice(0, 13).toString('ascii');
    if (!header.startsWith('silhouette05;')) {
      throw new Error('Not a valid .studio3 file');
    }
  }

  _findPngBoundaries() {
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const PNG_END = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    
    const images = [];
    let pos = 0;
    
    while (pos < this.data.length) {
      const start = this.data.indexOf(PNG_SIG, pos);
      if (start === -1) break;
      
      const end = this.data.indexOf(PNG_END, start);
      if (end === -1) break;
      
      images.push({
        start,
        end: end + PNG_END.length
      });
      pos = end + PNG_END.length;
    }
    
    return images;
  }

  extractImages() {
    const boundaries = this._findPngBoundaries();
    return boundaries.map((b, i) => ({
      index: i,
      buffer: this.data.slice(b.start, b.end),
      size: b.end - b.start,
      offset: b.start
    }));
  }

  extractCutPaths() {
    // Get header section (before first PNG)
    const images = this._findPngBoundaries();
    const headerEnd = images.length > 0 ? images[0].start : this.data.length;
    const header = this.data.slice(0, headerEnd);

    // Parse using marker pattern (uint32 value 33 precedes each coordinate pair)
    const allPoints = [];
    
    for (let i = 0; i < header.length - 12; i += 4) {
      const marker = header.readUInt32LE(i);
      
      if (marker === 33) {
        const x = header.readFloatLE(i + 4);
        const y = header.readFloatLE(i + 8);
        
        // Filter to valid coordinate range
        if (x > 0 && x < 10000 && y > 0 && y < 10000) {
          allPoints.push({ offset: i, x, y });
        }
      }
    }

    if (allPoints.length === 0) return [];

    // Group into separate paths by file offset proximity
    const paths = [];
    let currentPath = [allPoints[0]];

    for (let i = 1; i < allPoints.length; i++) {
      if (allPoints[i].offset - allPoints[i - 1].offset > 500) {
        // New path starts
        if (currentPath.length > 2) {
          paths.push(currentPath.map(p => ({ x: p.x, y: p.y })));
        }
        currentPath = [allPoints[i]];
      } else {
        currentPath.push(allPoints[i]);
      }
    }

    // Don't forget last path
    if (currentPath.length > 2) {
      paths.push(currentPath.map(p => ({ x: p.x, y: p.y })));
    }

    return paths;
  }

  extractMetadata() {
    // Extract readable strings from first 2KB
    const header = this.data.slice(0, 2000);
    const strings = [];
    let current = '';
    
    for (let i = 0; i < header.length; i++) {
      const char = header[i];
      if (char >= 32 && char < 127) {
        current += String.fromCharCode(char);
      } else {
        if (current.length >= 4) {
          strings.push(current);
        }
        current = '';
      }
    }

    const metadata = {
      formatVersion: 'silhouette05',
      filename: path.basename(this.filepath),
      strings: strings
    };

    // Parse known fields
    for (const s of strings) {
      if (s.includes('Paper') || s.includes('Vinyl')) {
        metadata.material = s;
      }
      if (s.toLowerCase().includes('cameo')) {
        metadata.device = s;
      }
    }

    return metadata;
  }

  toSvg(options = {}) {
    const paths = this.extractCutPaths();
    const images = this._findPngBoundaries();
    
    // Determine canvas size
    let width = options.width || 3000;
    let height = options.height || 3000;

    if (paths.length > 0) {
      const allX = paths.flatMap(p => p.map(pt => pt.x));
      const allY = paths.flatMap(p => p.map(pt => pt.y));
      width = Math.ceil(Math.max(...allX)) + 100;
      height = Math.ceil(Math.max(...allY)) + 100;
    }

    // Build SVG paths
    const svgPaths = paths.map((path, i) => {
      if (path.length < 2) return '';
      
      let d = `M ${path[0].x.toFixed(2)},${path[0].y.toFixed(2)}`;
      for (let j = 1; j < path.length; j++) {
        d += ` L ${path[j].x.toFixed(2)},${path[j].y.toFixed(2)}`;
      }
      d += ' Z';
      
      const color = options.colors?.[i] || 'red';
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
    }).filter(Boolean);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${svgPaths.join('\n  ')}
</svg>`;
  }

  async parse() {
    if (!this.data) {
      await this.load();
    }

    return {
      images: this.extractImages(),
      paths: this.extractCutPaths(),
      metadata: this.extractMetadata(),
      svg: this.toSvg()
    };
  }

  // Convenience methods for print-station integration
  
  async saveImages(outputDir) {
    const images = this.extractImages();
    const saved = [];
    
    for (const img of images) {
      const filename = path.join(outputDir, `${path.basename(this.filepath, '.studio3')}_${img.index}.png`);
      await fs.writeFile(filename, img.buffer);
      saved.push(filename);
    }
    
    return saved;
  }

  async saveSvg(outputPath) {
    const svg = this.toSvg();
    await fs.writeFile(outputPath, svg);
    return outputPath;
  }

  getPathBounds(pathIndex = 0) {
    const paths = this.extractCutPaths();
    if (pathIndex >= paths.length) return null;
    
    const path = paths[pathIndex];
    const xs = path.map(p => p.x);
    const ys = path.map(p => p.y);
    
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  }
}

module.exports = Studio3Parser;

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node studio3-parser.js <file.studio3>');
    process.exit(1);
  }

  (async () => {
    const parser = new Studio3Parser(args[0]);
    const data = await parser.parse();
    
    console.log('=== METADATA ===');
    console.log(JSON.stringify(data.metadata, null, 2));
    
    console.log('\n=== IMAGES ===');
    data.images.forEach(img => {
      console.log(`  Image ${img.index}: ${img.size} bytes`);
    });
    
    console.log('\n=== CUT PATHS ===');
    data.paths.forEach((path, i) => {
      const bounds = parser.getPathBounds(i);
      console.log(`  Path ${i}: ${path.length} points`);
      console.log(`    Bounds: (${bounds.minX.toFixed(1)}, ${bounds.minY.toFixed(1)}) to (${bounds.maxX.toFixed(1)}, ${bounds.maxY.toFixed(1)})`);
    });
  })();
}
