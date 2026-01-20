/**
 * Designer AI Assistant
 * Claude API integration for intelligent design suggestions
 */

const Anthropic = require('@anthropic-ai/sdk');

// Initialize Claude client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Analyze design and provide AI suggestions
 */
async function analyzeDesign(designData) {
  const {
    objects = [],
    canvasSize = 4,
    selectedColor = '#FFFFFF',
    catalog = []
  } = designData;

  // Build context for Claude
  const context = buildDesignContext(objects, canvasSize, selectedColor);

  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an expert vinyl decal designer assistant. Analyze this design and provide helpful, specific suggestions.

Current Design:
${context}

Available Catalog: ${catalog.length} designs across multiple categories

Provide 2-3 specific, actionable suggestions to improve this design. Focus on:
- Layout and composition
- Text placement and hierarchy
- Color harmony
- Balance and spacing
- Professional best practices for vinyl decals

Format your response as a JSON array of suggestions, each with:
{
  "type": "layout" | "text" | "color" | "spacing" | "general",
  "priority": "high" | "medium" | "low",
  "suggestion": "Clear, actionable suggestion text"
}

Keep suggestions concise and friendly.`
    }]
  });

  try {
    const response = message.content[0].text;
    const suggestions = JSON.parse(response);
    return suggestions;
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return getFallbackSuggestions(objects);
  }
}

/**
 * Build design context for Claude
 */
function buildDesignContext(objects, canvasSize, selectedColor) {
  const hasText = objects.filter(obj => obj.type === 'text');
  const hasImages = objects.filter(obj => obj.type === 'image');

  let context = `Canvas Size: ${canvasSize}" × ${canvasSize}"\n`;
  context += `Vinyl Color: ${selectedColor}\n`;
  context += `Total Objects: ${objects.length}\n`;
  context += `Text Elements: ${hasText.length}\n`;
  context += `Images: ${hasImages.length}\n\n`;

  if (hasText.length > 0) {
    context += 'Text Elements:\n';
    hasText.forEach((obj, i) => {
      context += `  ${i + 1}. "${obj.text}" (${obj.fontFamily}, ${obj.fontSize}px)\n`;
    });
    context += '\n';
  }

  if (hasImages.length > 0) {
    context += `Image Elements: ${hasImages.length} images\n`;
  }

  // Analyze layout
  if (objects.length > 0) {
    const centerX = (canvasSize * 96) / 2;
    const centerY = (canvasSize * 96) / 2;
    const centered = objects.filter(obj =>
      Math.abs(obj.left - centerX) < 50 && Math.abs(obj.top - centerY) < 50
    );

    context += `\nLayout Analysis:\n`;
    context += `  Centered elements: ${centered.length}\n`;

    if (objects.length > 1) {
      const spacing = analyzeSpacing(objects);
      context += `  Average spacing: ${spacing.toFixed(0)}px\n`;
    }
  }

  return context;
}

/**
 * Analyze spacing between objects
 */
function analyzeSpacing(objects) {
  if (objects.length < 2) return 0;

  let totalSpacing = 0;
  let count = 0;

  for (let i = 0; i < objects.length - 1; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const dx = objects[i].left - objects[j].left;
      const dy = objects[i].top - objects[j].top;
      const distance = Math.sqrt(dx * dx + dy * dy);
      totalSpacing += distance;
      count++;
    }
  }

  return count > 0 ? totalSpacing / count : 0;
}

/**
 * Get fallback suggestions if AI fails
 */
function getFallbackSuggestions(objects) {
  const suggestions = [];

  if (objects.length === 0) {
    suggestions.push({
      type: 'general',
      priority: 'high',
      suggestion: 'Start by adding an image from the catalog or create text to begin your design.'
    });
  } else if (objects.length === 1) {
    const obj = objects[0];
    if (obj.type === 'text') {
      suggestions.push({
        type: 'general',
        priority: 'medium',
        suggestion: 'Add a complementary image from the catalog to enhance your text.'
      });
    } else {
      suggestions.push({
        type: 'text',
        priority: 'medium',
        suggestion: 'Add text to communicate your message clearly.'
      });
    }
  } else if (objects.length >= 3) {
    suggestions.push({
      type: 'layout',
      priority: 'medium',
      suggestion: 'Use alignment tools to create a clean, organized layout with your multiple elements.'
    });
  }

  // Always add a general tip
  suggestions.push({
    type: 'general',
    priority: 'low',
    suggestion: 'Remember that vinyl decals look best with clear hierarchy and balanced spacing.'
  });

  return suggestions;
}

/**
 * Suggest catalog items based on current design
 */
async function suggestCatalogItems(designData, catalogData) {
  const {
    objects = [],
    selectedCategory = '',
    theme = ''
  } = designData;

  const hasText = objects.some(obj => obj.type === 'text');
  const textContent = hasText ? objects.find(obj => obj.type === 'text')?.text : '';

  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Suggest 3-5 catalog items that would complement this design:

Current Design:
- Has ${objects.length} objects
- Text: "${textContent}"
- Category context: ${selectedCategory || 'none'}
- Theme: ${theme || 'general'}

Available Categories: ${catalogData.categories?.map(c => c.name).join(', ')}

Respond with a JSON array of category slugs to recommend:
["category-slug-1", "category-slug-2", ...]

Focus on visual harmony and thematic consistency.`
    }]
  });

  try {
    const response = message.content[0].text;
    return JSON.parse(response);
  } catch (error) {
    console.error('Failed to parse catalog suggestions:', error);
    return [];
  }
}

/**
 * Suggest font pairings for text
 */
async function suggestFonts(textContent, currentFont) {
  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Suggest 3 complementary fonts for this text on a vinyl decal:

Text: "${textContent}"
Current Font: ${currentFont}

Available Fonts: Barlow, Bebas Neue, Montserrat, Oswald, Pacifico, Playfair Display, Raleway, Roboto, Lobster, Anton, Righteous, Permanent Marker, Bangers, Racing Sans One, Rubik Mono One

Respond with a JSON array of font recommendations:
[
  {
    "font": "Font Name",
    "reason": "Brief reason why this works",
    "priority": "primary" | "secondary" | "alternative"
  }
]`
    }]
  });

  try {
    const response = message.content[0].text;
    return JSON.parse(response);
  } catch (error) {
    console.error('Failed to parse font suggestions:', error);
    return getDefaultFontSuggestions(currentFont);
  }
}

/**
 * Default font suggestions
 */
function getDefaultFontSuggestions(currentFont) {
  const pairings = {
    'Barlow': ['Playfair Display', 'Bebas Neue', 'Montserrat'],
    'Bebas Neue': ['Barlow', 'Roboto', 'Raleway'],
    'Montserrat': ['Playfair Display', 'Barlow', 'Oswald'],
    'Oswald': ['Montserrat', 'Raleway', 'Barlow'],
    'Pacifico': ['Montserrat', 'Barlow', 'Raleway'],
    'Anton': ['Barlow', 'Montserrat', 'Raleway'],
    'Bangers': ['Barlow', 'Anton', 'Racing Sans One']
  };

  const suggestions = pairings[currentFont] || ['Barlow', 'Montserrat', 'Oswald'];

  return suggestions.map((font, i) => ({
    font,
    reason: 'Good visual contrast and readability',
    priority: i === 0 ? 'primary' : i === 1 ? 'secondary' : 'alternative'
  }));
}

/**
 * Suggest vinyl colors based on design
 */
async function suggestColors(designData, vinylPalette) {
  const {
    objects = [],
    theme = '',
    currentColor = '#FFFFFF'
  } = designData;

  const availableColors = vinylPalette.map(c => `${c.name} (${c.value})`).join(', ');

  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Recommend vinyl colors for this decal design:

Current Color: ${currentColor}
Theme: ${theme || 'general'}
Design has ${objects.length} elements

Available Vinyl Colors:
${availableColors}

Respond with a JSON array of 3 color recommendations:
[
  {
    "color": "Color Name",
    "value": "#HEXCODE",
    "reason": "Why this color works for vinyl decals"
  }
]

Consider: visibility, professionalism, and vinyl cutting characteristics.`
    }]
  });

  try {
    const response = message.content[0].text;
    return JSON.parse(response);
  } catch (error) {
    console.error('Failed to parse color suggestions:', error);
    return getDefaultColorSuggestions(vinylPalette, currentColor);
  }
}

/**
 * Default color suggestions
 */
function getDefaultColorSuggestions(palette, currentColor) {
  // Suggest high-contrast colors
  const suggestions = [];

  // Always suggest black and white as safe options
  const black = palette.find(c => c.value.toLowerCase() === '#201f1d' || c.name.includes('Black'));
  const white = palette.find(c => c.value.toLowerCase() === '#ffffff' || c.name.includes('White'));

  if (black && black.value !== currentColor) {
    suggestions.push({
      color: black.name,
      value: black.value,
      reason: 'High contrast and professional appearance'
    });
  }

  if (white && white.value !== currentColor) {
    suggestions.push({
      color: white.name,
      value: white.value,
      reason: 'Clean, versatile, works on dark surfaces'
    });
  }

  // Add one vibrant color
  const vibrant = palette.find(c =>
    c.name.includes('Red') || c.name.includes('Blue') || c.name.includes('Gold')
  );

  if (vibrant) {
    suggestions.push({
      color: vibrant.name,
      value: vibrant.value,
      reason: 'Eye-catching and memorable'
    });
  }

  return suggestions.slice(0, 3);
}

module.exports = {
  analyzeDesign,
  suggestCatalogItems,
  suggestFonts,
  suggestColors
};
