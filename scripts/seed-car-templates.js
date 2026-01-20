/**
 * Seed initial car templates for the race decal designer
 * Run with: node scripts/seed-car-templates.js
 */

const path = require('path');
const db = require('../server/db');

// Initialize the database (creates tables if needed)
db.initDatabase();

// Car template data with real-world dimensions (in inches)
const CAR_TEMPLATES = [
  {
    make: 'Subaru',
    model: 'WRX',
    yearStart: 2015,
    yearEnd: 2021,
    bodyStyle: 'Sedan',
    overallLength: 180.9,
    overallWidth: 70.7,
    overallHeight: 58.1,
    wheelbase: 104.3
  },
  {
    make: 'Subaru',
    model: 'WRX STI',
    yearStart: 2015,
    yearEnd: 2021,
    bodyStyle: 'Sedan',
    overallLength: 180.9,
    overallWidth: 70.7,
    overallHeight: 57.5,
    wheelbase: 104.3
  },
  {
    make: 'Subaru',
    model: 'WRX',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Sedan',
    overallLength: 183.1,
    overallWidth: 71.7,
    overallHeight: 56.5,
    wheelbase: 105.1
  },
  {
    make: 'Mazda',
    model: 'MX-5 Miata',
    yearStart: 2016,
    yearEnd: 2024,
    bodyStyle: 'Convertible',
    overallLength: 154.1,
    overallWidth: 68.3,
    overallHeight: 48.6,
    wheelbase: 90.9
  },
  {
    make: 'Toyota',
    model: 'GR86',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Coupe',
    overallLength: 167.9,
    overallWidth: 69.9,
    overallHeight: 51.2,
    wheelbase: 101.4
  },
  {
    make: 'Subaru',
    model: 'BRZ',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Coupe',
    overallLength: 167.9,
    overallWidth: 69.9,
    overallHeight: 51.6,
    wheelbase: 101.4
  },
  {
    make: 'Honda',
    model: 'Civic',
    yearStart: 2016,
    yearEnd: 2021,
    bodyStyle: 'Sedan',
    overallLength: 182.3,
    overallWidth: 70.9,
    overallHeight: 55.7,
    wheelbase: 106.3
  },
  {
    make: 'Honda',
    model: 'Civic',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Sedan',
    overallLength: 184.0,
    overallWidth: 71.0,
    overallHeight: 55.4,
    wheelbase: 107.7
  },
  {
    make: 'Honda',
    model: 'Civic Si',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Sedan',
    overallLength: 184.0,
    overallWidth: 71.0,
    overallHeight: 55.4,
    wheelbase: 107.7
  },
  {
    make: 'Honda',
    model: 'Civic Type R',
    yearStart: 2023,
    yearEnd: 2024,
    bodyStyle: 'Hatchback',
    overallLength: 180.9,
    overallWidth: 75.0,
    overallHeight: 55.4,
    wheelbase: 107.7
  },
  {
    make: 'Ford',
    model: 'Mustang',
    yearStart: 2015,
    yearEnd: 2023,
    bodyStyle: 'Coupe',
    overallLength: 188.5,
    overallWidth: 75.4,
    overallHeight: 54.3,
    wheelbase: 107.1
  },
  {
    make: 'Ford',
    model: 'Mustang',
    yearStart: 2024,
    yearEnd: 2025,
    bodyStyle: 'Coupe',
    overallLength: 189.4,
    overallWidth: 75.4,
    overallHeight: 54.2,
    wheelbase: 107.1
  },
  {
    make: 'BMW',
    model: '3 Series',
    yearStart: 2019,
    yearEnd: 2024,
    bodyStyle: 'Sedan',
    overallLength: 185.7,
    overallWidth: 71.9,
    overallHeight: 56.8,
    wheelbase: 112.2
  },
  {
    make: 'Volkswagen',
    model: 'GTI',
    yearStart: 2015,
    yearEnd: 2021,
    bodyStyle: 'Hatchback',
    overallLength: 168.4,
    overallWidth: 70.4,
    overallHeight: 57.2,
    wheelbase: 103.6
  },
  {
    make: 'Volkswagen',
    model: 'GTI',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Hatchback',
    overallLength: 168.5,
    overallWidth: 70.4,
    overallHeight: 57.5,
    wheelbase: 103.6
  },
  {
    make: 'Porsche',
    model: '911',
    yearStart: 2020,
    yearEnd: 2024,
    bodyStyle: 'Coupe',
    overallLength: 177.9,
    overallWidth: 72.9,
    overallHeight: 50.8,
    wheelbase: 96.5
  },
  {
    make: 'Chevrolet',
    model: 'Camaro',
    yearStart: 2016,
    yearEnd: 2024,
    bodyStyle: 'Coupe',
    overallLength: 188.3,
    overallWidth: 74.7,
    overallHeight: 53.1,
    wheelbase: 110.7
  },
  {
    make: 'Nissan',
    model: '370Z',
    yearStart: 2009,
    yearEnd: 2020,
    bodyStyle: 'Coupe',
    overallLength: 167.5,
    overallWidth: 72.6,
    overallHeight: 51.8,
    wheelbase: 100.4
  },
  {
    make: 'Nissan',
    model: 'Z',
    yearStart: 2023,
    yearEnd: 2024,
    bodyStyle: 'Coupe',
    overallLength: 172.4,
    overallWidth: 72.8,
    overallHeight: 51.8,
    wheelbase: 100.4
  },
  {
    make: 'Hyundai',
    model: 'Veloster N',
    yearStart: 2019,
    yearEnd: 2022,
    bodyStyle: 'Hatchback',
    overallLength: 167.9,
    overallWidth: 70.9,
    overallHeight: 55.1,
    wheelbase: 104.3
  },
  {
    make: 'Hyundai',
    model: 'Elantra N',
    yearStart: 2022,
    yearEnd: 2024,
    bodyStyle: 'Sedan',
    overallLength: 184.1,
    overallWidth: 71.9,
    overallHeight: 55.7,
    wheelbase: 107.1
  }
];

/**
 * Generate a parametric side-view SVG template based on car dimensions
 * Scale: 0.1 inches per pixel (so 180 inches = 1800 pixels)
 */
function generateSideTemplate(car) {
  const scale = 0.1; // inches per pixel
  const width = Math.round(car.overallLength / scale);
  const height = Math.round(car.overallHeight / scale) + 100; // Extra padding for wheels
  const wheelbase = Math.round(car.wheelbase / scale);
  const bodyHeight = Math.round(car.overallHeight / scale);

  // Calculate proportions based on body style
  let roofStart, roofEnd, hoodEnd, trunkStart;

  switch (car.bodyStyle) {
    case 'Coupe':
      roofStart = width * 0.28;
      roofEnd = width * 0.72;
      hoodEnd = width * 0.25;
      trunkStart = width * 0.75;
      break;
    case 'Convertible':
      roofStart = width * 0.32;
      roofEnd = width * 0.65;
      hoodEnd = width * 0.28;
      trunkStart = width * 0.68;
      break;
    case 'Hatchback':
      roofStart = width * 0.25;
      roofEnd = width * 0.85;
      hoodEnd = width * 0.22;
      trunkStart = width * 0.85;
      break;
    default: // Sedan
      roofStart = width * 0.25;
      roofEnd = width * 0.75;
      hoodEnd = width * 0.22;
      trunkStart = width * 0.78;
  }

  // Wheel positions based on wheelbase
  const frontWheelX = (width - wheelbase) / 2 + 50;
  const rearWheelX = frontWheelX + wheelbase;
  const wheelRadius = 45;
  const groundY = height - 50;
  const wheelY = groundY - wheelRadius;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <style>
      .body { fill: #e8e8e8; stroke: #333; stroke-width: 2; }
      .window { fill: #a8d4f0; stroke: #333; stroke-width: 1.5; }
      .wheel { fill: #222; stroke: #111; stroke-width: 2; }
      .wheel-center { fill: #444; }
      .ground { stroke: #999; stroke-width: 1; stroke-dasharray: 10,5; }
      .dimension { fill: none; stroke: #0066cc; stroke-width: 1; }
      .dim-text { font-family: Arial, sans-serif; font-size: 12px; fill: #0066cc; }
      .decal-zone { fill: rgba(255,200,0,0.1); stroke: #ffcc00; stroke-width: 1; stroke-dasharray: 5,3; }
    </style>
  </defs>

  <!-- Ground reference line -->
  <line class="ground" x1="0" y1="${groundY}" x2="${width}" y2="${groundY}" />

  <!-- Car body outline -->
  <path class="body" d="
    M ${hoodEnd} ${groundY - bodyHeight * 0.35}
    L ${hoodEnd * 0.3} ${groundY - bodyHeight * 0.3}
    Q ${hoodEnd * 0.1} ${groundY - bodyHeight * 0.25} ${hoodEnd * 0.1} ${groundY - bodyHeight * 0.2}
    L ${hoodEnd * 0.08} ${groundY - wheelRadius - 10}
    Q ${frontWheelX - wheelRadius - 20} ${groundY - wheelRadius - 10} ${frontWheelX - wheelRadius - 10} ${groundY - wheelRadius}
    A ${wheelRadius + 10} ${wheelRadius + 10} 0 0 0 ${frontWheelX + wheelRadius + 10} ${groundY - wheelRadius}
    L ${rearWheelX - wheelRadius - 10} ${groundY - wheelRadius}
    A ${wheelRadius + 10} ${wheelRadius + 10} 0 0 0 ${rearWheelX + wheelRadius + 10} ${groundY - wheelRadius}
    Q ${width * 0.97} ${groundY - wheelRadius - 10} ${width * 0.97} ${groundY - bodyHeight * 0.2}
    L ${width * 0.95} ${groundY - bodyHeight * 0.35}
    Q ${trunkStart} ${groundY - bodyHeight * 0.4} ${roofEnd} ${groundY - bodyHeight * 0.85}
    L ${roofStart} ${groundY - bodyHeight * 0.85}
    Q ${hoodEnd + 20} ${groundY - bodyHeight * 0.5} ${hoodEnd} ${groundY - bodyHeight * 0.35}
    Z
  "/>

  <!-- Window area -->
  <path class="window" d="
    M ${roofStart + 20} ${groundY - bodyHeight * 0.82}
    L ${roofEnd - 20} ${groundY - bodyHeight * 0.82}
    Q ${roofEnd - 10} ${groundY - bodyHeight * 0.5} ${trunkStart - 30} ${groundY - bodyHeight * 0.42}
    L ${roofStart + 50} ${groundY - bodyHeight * 0.42}
    Q ${roofStart + 30} ${groundY - bodyHeight * 0.5} ${roofStart + 20} ${groundY - bodyHeight * 0.82}
    Z
  "/>

  <!-- Wheels -->
  <circle class="wheel" cx="${frontWheelX}" cy="${wheelY}" r="${wheelRadius}" />
  <circle class="wheel-center" cx="${frontWheelX}" cy="${wheelY}" r="${wheelRadius * 0.5}" />
  <circle class="wheel" cx="${rearWheelX}" cy="${wheelY}" r="${wheelRadius}" />
  <circle class="wheel-center" cx="${rearWheelX}" cy="${wheelY}" r="${wheelRadius * 0.5}" />

  <!-- Door number zone (highlighted) -->
  <rect class="decal-zone" x="${roofStart + 60}" y="${groundY - bodyHeight * 0.65}"
        width="${(roofEnd - roofStart) * 0.5}" height="${bodyHeight * 0.35}" rx="5"
        data-zone="door-number" data-recommended="true" />

  <!-- Fender zone -->
  <rect class="decal-zone" x="${hoodEnd * 0.5}" y="${groundY - bodyHeight * 0.5}"
        width="${hoodEnd * 0.8}" height="${bodyHeight * 0.25}" rx="3"
        data-zone="front-fender" />

  <!-- Dimension markers -->
  <g class="dimensions">
    <!-- Overall length -->
    <line class="dimension" x1="20" y1="${height - 20}" x2="${width - 20}" y2="${height - 20}" />
    <line class="dimension" x1="20" y1="${height - 25}" x2="20" y2="${height - 15}" />
    <line class="dimension" x1="${width - 20}" y1="${height - 25}" x2="${width - 20}" y2="${height - 15}" />
    <text class="dim-text" x="${width / 2}" y="${height - 8}" text-anchor="middle">${car.overallLength}" overall length</text>

    <!-- Wheelbase -->
    <line class="dimension" x1="${frontWheelX}" y1="${groundY + 20}" x2="${rearWheelX}" y2="${groundY + 20}" />
    <line class="dimension" x1="${frontWheelX}" y1="${groundY + 15}" x2="${frontWheelX}" y2="${groundY + 25}" />
    <line class="dimension" x1="${rearWheelX}" y1="${groundY + 15}" x2="${rearWheelX}" y2="${groundY + 25}" />
    <text class="dim-text" x="${(frontWheelX + rearWheelX) / 2}" y="${groundY + 35}" text-anchor="middle">${car.wheelbase}" wheelbase</text>
  </g>

  <!-- Metadata -->
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description>
        <scale>${scale}</scale>
        <unit>inches</unit>
        <make>${car.make}</make>
        <model>${car.model}</model>
        <yearRange>${car.yearStart}-${car.yearEnd}</yearRange>
      </rdf:Description>
    </rdf:RDF>
  </metadata>
</svg>`;
}

/**
 * Generate front view SVG template
 */
function generateFrontTemplate(car) {
  const scale = 0.1;
  const width = Math.round(car.overallWidth / scale) + 100;
  const height = Math.round(car.overallHeight / scale) + 100;
  const bodyWidth = Math.round(car.overallWidth / scale);
  const bodyHeight = Math.round(car.overallHeight / scale);

  const centerX = width / 2;
  const groundY = height - 50;
  const wheelRadius = 40;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <style>
      .body { fill: #e8e8e8; stroke: #333; stroke-width: 2; }
      .window { fill: #a8d4f0; stroke: #333; stroke-width: 1.5; }
      .grille { fill: #222; stroke: #333; stroke-width: 1; }
      .headlight { fill: #fff8dc; stroke: #333; stroke-width: 1; }
      .wheel { fill: #222; stroke: #111; stroke-width: 2; }
      .ground { stroke: #999; stroke-width: 1; stroke-dasharray: 10,5; }
      .decal-zone { fill: rgba(255,200,0,0.1); stroke: #ffcc00; stroke-width: 1; stroke-dasharray: 5,3; }
      .dim-text { font-family: Arial, sans-serif; font-size: 12px; fill: #0066cc; }
    </style>
  </defs>

  <!-- Ground line -->
  <line class="ground" x1="0" y1="${groundY}" x2="${width}" y2="${groundY}" />

  <!-- Car body - front view -->
  <path class="body" d="
    M ${centerX - bodyWidth * 0.48} ${groundY - bodyHeight * 0.2}
    Q ${centerX - bodyWidth * 0.5} ${groundY - bodyHeight * 0.3} ${centerX - bodyWidth * 0.48} ${groundY - bodyHeight * 0.4}
    L ${centerX - bodyWidth * 0.45} ${groundY - bodyHeight * 0.55}
    Q ${centerX - bodyWidth * 0.35} ${groundY - bodyHeight * 0.85} ${centerX - bodyWidth * 0.25} ${groundY - bodyHeight * 0.92}
    L ${centerX + bodyWidth * 0.25} ${groundY - bodyHeight * 0.92}
    Q ${centerX + bodyWidth * 0.35} ${groundY - bodyHeight * 0.85} ${centerX + bodyWidth * 0.45} ${groundY - bodyHeight * 0.55}
    L ${centerX + bodyWidth * 0.48} ${groundY - bodyHeight * 0.4}
    Q ${centerX + bodyWidth * 0.5} ${groundY - bodyHeight * 0.3} ${centerX + bodyWidth * 0.48} ${groundY - bodyHeight * 0.2}
    L ${centerX + bodyWidth * 0.45} ${groundY - wheelRadius}
    A ${wheelRadius} ${wheelRadius * 0.6} 0 0 0 ${centerX + bodyWidth * 0.3} ${groundY - wheelRadius}
    L ${centerX - bodyWidth * 0.3} ${groundY - wheelRadius}
    A ${wheelRadius} ${wheelRadius * 0.6} 0 0 0 ${centerX - bodyWidth * 0.45} ${groundY - wheelRadius}
    Z
  "/>

  <!-- Windshield -->
  <path class="window" d="
    M ${centerX - bodyWidth * 0.22} ${groundY - bodyHeight * 0.88}
    L ${centerX + bodyWidth * 0.22} ${groundY - bodyHeight * 0.88}
    Q ${centerX + bodyWidth * 0.3} ${groundY - bodyHeight * 0.8} ${centerX + bodyWidth * 0.35} ${groundY - bodyHeight * 0.58}
    L ${centerX - bodyWidth * 0.35} ${groundY - bodyHeight * 0.58}
    Q ${centerX - bodyWidth * 0.3} ${groundY - bodyHeight * 0.8} ${centerX - bodyWidth * 0.22} ${groundY - bodyHeight * 0.88}
    Z
  "/>

  <!-- Grille -->
  <rect class="grille" x="${centerX - bodyWidth * 0.2}" y="${groundY - bodyHeight * 0.35}"
        width="${bodyWidth * 0.4}" height="${bodyHeight * 0.12}" rx="3" />

  <!-- Headlights -->
  <ellipse class="headlight" cx="${centerX - bodyWidth * 0.35}" cy="${groundY - bodyHeight * 0.38}" rx="${bodyWidth * 0.08}" ry="${bodyHeight * 0.05}" />
  <ellipse class="headlight" cx="${centerX + bodyWidth * 0.35}" cy="${groundY - bodyHeight * 0.38}" rx="${bodyWidth * 0.08}" ry="${bodyHeight * 0.05}" />

  <!-- Wheels (visible from front) -->
  <ellipse class="wheel" cx="${centerX - bodyWidth * 0.38}" cy="${groundY - wheelRadius * 0.7}" rx="${wheelRadius * 0.4}" ry="${wheelRadius * 0.7}" />
  <ellipse class="wheel" cx="${centerX + bodyWidth * 0.38}" cy="${groundY - wheelRadius * 0.7}" rx="${wheelRadius * 0.4}" ry="${wheelRadius * 0.7}" />

  <!-- Hood number zone -->
  <rect class="decal-zone" x="${centerX - bodyWidth * 0.25}" y="${groundY - bodyHeight * 0.52}"
        width="${bodyWidth * 0.5}" height="${bodyHeight * 0.15}" rx="5"
        data-zone="hood" data-recommended="true" />

  <!-- Width dimension -->
  <text class="dim-text" x="${centerX}" y="${height - 15}" text-anchor="middle">${car.overallWidth}" width</text>
</svg>`;
}

/**
 * Generate rear view SVG template
 */
function generateRearTemplate(car) {
  const scale = 0.1;
  const width = Math.round(car.overallWidth / scale) + 100;
  const height = Math.round(car.overallHeight / scale) + 100;
  const bodyWidth = Math.round(car.overallWidth / scale);
  const bodyHeight = Math.round(car.overallHeight / scale);

  const centerX = width / 2;
  const groundY = height - 50;
  const wheelRadius = 40;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <style>
      .body { fill: #e8e8e8; stroke: #333; stroke-width: 2; }
      .window { fill: #a8d4f0; stroke: #333; stroke-width: 1.5; }
      .taillight { fill: #cc2222; stroke: #333; stroke-width: 1; }
      .wheel { fill: #222; stroke: #111; stroke-width: 2; }
      .ground { stroke: #999; stroke-width: 1; stroke-dasharray: 10,5; }
      .decal-zone { fill: rgba(255,200,0,0.1); stroke: #ffcc00; stroke-width: 1; stroke-dasharray: 5,3; }
      .dim-text { font-family: Arial, sans-serif; font-size: 12px; fill: #0066cc; }
    </style>
  </defs>

  <!-- Ground line -->
  <line class="ground" x1="0" y1="${groundY}" x2="${width}" y2="${groundY}" />

  <!-- Car body - rear view -->
  <path class="body" d="
    M ${centerX - bodyWidth * 0.48} ${groundY - bodyHeight * 0.2}
    L ${centerX - bodyWidth * 0.48} ${groundY - bodyHeight * 0.45}
    Q ${centerX - bodyWidth * 0.45} ${groundY - bodyHeight * 0.75} ${centerX - bodyWidth * 0.3} ${groundY - bodyHeight * 0.88}
    L ${centerX + bodyWidth * 0.3} ${groundY - bodyHeight * 0.88}
    Q ${centerX + bodyWidth * 0.45} ${groundY - bodyHeight * 0.75} ${centerX + bodyWidth * 0.48} ${groundY - bodyHeight * 0.45}
    L ${centerX + bodyWidth * 0.48} ${groundY - bodyHeight * 0.2}
    L ${centerX + bodyWidth * 0.45} ${groundY - wheelRadius}
    A ${wheelRadius} ${wheelRadius * 0.6} 0 0 0 ${centerX + bodyWidth * 0.3} ${groundY - wheelRadius}
    L ${centerX - bodyWidth * 0.3} ${groundY - wheelRadius}
    A ${wheelRadius} ${wheelRadius * 0.6} 0 0 0 ${centerX - bodyWidth * 0.45} ${groundY - wheelRadius}
    Z
  "/>

  <!-- Rear window -->
  <path class="window" d="
    M ${centerX - bodyWidth * 0.28} ${groundY - bodyHeight * 0.85}
    L ${centerX + bodyWidth * 0.28} ${groundY - bodyHeight * 0.85}
    Q ${centerX + bodyWidth * 0.38} ${groundY - bodyHeight * 0.72} ${centerX + bodyWidth * 0.4} ${groundY - bodyHeight * 0.55}
    L ${centerX - bodyWidth * 0.4} ${groundY - bodyHeight * 0.55}
    Q ${centerX - bodyWidth * 0.38} ${groundY - bodyHeight * 0.72} ${centerX - bodyWidth * 0.28} ${groundY - bodyHeight * 0.85}
    Z
  "/>

  <!-- Taillights -->
  <rect class="taillight" x="${centerX - bodyWidth * 0.45}" y="${groundY - bodyHeight * 0.4}"
        width="${bodyWidth * 0.1}" height="${bodyHeight * 0.08}" rx="2" />
  <rect class="taillight" x="${centerX + bodyWidth * 0.35}" y="${groundY - bodyHeight * 0.4}"
        width="${bodyWidth * 0.1}" height="${bodyHeight * 0.08}" rx="2" />

  <!-- Wheels -->
  <ellipse class="wheel" cx="${centerX - bodyWidth * 0.38}" cy="${groundY - wheelRadius * 0.7}" rx="${wheelRadius * 0.4}" ry="${wheelRadius * 0.7}" />
  <ellipse class="wheel" cx="${centerX + bodyWidth * 0.38}" cy="${groundY - wheelRadius * 0.7}" rx="${wheelRadius * 0.4}" ry="${wheelRadius * 0.7}" />

  <!-- Trunk/rear number zone -->
  <rect class="decal-zone" x="${centerX - bodyWidth * 0.2}" y="${groundY - bodyHeight * 0.5}"
        width="${bodyWidth * 0.4}" height="${bodyHeight * 0.12}" rx="3"
        data-zone="trunk" />
</svg>`;
}

// Run the seeding
console.log('Seeding car templates...\n');

let created = 0;
let skipped = 0;

for (const car of CAR_TEMPLATES) {
  // Check if template already exists
  const existing = db.findCarTemplate(car.make, car.model, car.yearStart);
  if (existing) {
    console.log(`  Skipping: ${car.make} ${car.model} (${car.yearStart}-${car.yearEnd}) - already exists`);
    skipped++;
    continue;
  }

  // Generate SVG templates
  const templateSide = generateSideTemplate(car);
  const templateFront = generateFrontTemplate(car);
  const templateRear = generateRearTemplate(car);

  // Create the template
  const template = db.createCarTemplate({
    make: car.make,
    model: car.model,
    yearStart: car.yearStart,
    yearEnd: car.yearEnd,
    bodyStyle: car.bodyStyle,
    overallLength: car.overallLength,
    overallWidth: car.overallWidth,
    overallHeight: car.overallHeight,
    wheelbase: car.wheelbase,
    templateSide,
    templateFront,
    templateRear,
    scale: 0.1,
    isGenerated: false,
    verified: true
  });

  console.log(`  Created: ${car.make} ${car.model} (${car.yearStart}-${car.yearEnd}) [${template.id}]`);
  created++;
}

console.log(`\nDone! Created ${created} templates, skipped ${skipped} existing.`);
console.log('\nAvailable makes:', db.getDistinctCarMakes().join(', '));
