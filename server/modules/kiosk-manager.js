/**
 * Kiosk Display Manager
 *
 * WebSocket server for managing remote kiosk displays at trade shows/markets.
 * Integrates with save-design-server.js on port 4000.
 *
 * Usage:
 *   const kioskManager = require('./modules/kiosk-manager');
 *   kioskManager.init(httpServer);  // Pass your existing HTTP server
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const url = require('url');

// Get API key from environment (same as save-design-server.js)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.PRINT_STATION_API_KEY || null;

// Determine LIBRARY_ROOT (same logic as save-design-server.js)
const APP_ROOT = path.resolve(__dirname, '..', '..');
let LIBRARY_ROOT = APP_ROOT;
if (process.env.LIBRARY_ROOT) {
    try {
        const candidatePath = path.resolve(process.env.LIBRARY_ROOT);
        if (fs.existsSync(candidatePath)) {
            LIBRARY_ROOT = candidatePath;
        }
    } catch (e) {
        // Use default
    }
}
const CAMPAIGNS_DIR = path.join(LIBRARY_ROOT, 'data', 'campaigns');
const PROMOTIONS_DIR = path.join(LIBRARY_ROOT, 'data', 'kiosk-promotions');
const SHOPIFY_SLIDESHOWS_FILE = path.join(LIBRARY_ROOT, 'data', 'kiosk-promotions', 'shopify-slideshows.json');

// Ensure promotions directory exists
try {
    if (!fs.existsSync(PROMOTIONS_DIR)) {
        fs.mkdirSync(PROMOTIONS_DIR, { recursive: true });
    }
} catch (e) {
    console.warn('[Kiosk] Could not create promotions directory:', e.message);
}

class KioskManager {
    constructor() {
        this.displays = new Map();  // displayId -> { ws, name, currentContent, lastSeen }
        this.contentLibrary = [];   // Available content items
        this.promotions = [];       // Active promotions
        this.shopifySlideshows = []; // Saved Shopify product slideshows
        this.wss = null;

        // Rotating service slides
        this.serviceSlides = [];        // Available slide HTML files
        this.rotatingEnabled = false;   // Global toggle for rotating slides
        this.selectedSlideIds = null;   // Array of selected slide IDs (null = all)
        this.slideAssignments = new Map(); // displayId -> currently assigned slide
        this.rotationInterval = null;
        this.hideTimeout = null;        // Timeout for hiding slides to show campaign
    }

    /**
     * Initialize WebSocket server on existing HTTP server
     */
    init(httpServer) {
        this.wss = new WebSocket.Server({
            server: httpServer,
            path: '/kiosk-ws',
            // Verify client before allowing connection
            verifyClient: (info, callback) => {
                // If no API key configured, allow all connections
                if (!INTERNAL_API_KEY) {
                    callback(true);
                    return;
                }

                // Check for API key in query string: /kiosk-ws?key=YOUR_KEY
                const parsedUrl = url.parse(info.req.url, true);
                const queryKey = parsedUrl.query.key;

                if (queryKey === INTERNAL_API_KEY) {
                    callback(true);
                } else {
                    console.log('[Kiosk] WebSocket connection rejected: invalid or missing API key');
                    callback(false, 401, 'Unauthorized: Invalid or missing API key');
                }
            }
        });

        this.wss.on('connection', (ws, req) => {
            const displayId = this.generateDisplayId();
            console.log(`[Kiosk] Display connected: ${displayId}`);

            this.displays.set(displayId, {
                ws,
                name: `Display ${this.displays.size + 1}`,
                currentContent: null,
                lastSeen: Date.now(),
                ip: req.socket.remoteAddress
            });

            // Send initial registration
            ws.send(JSON.stringify({
                type: 'registered',
                displayId,
                name: `Display ${this.displays.size}`
            }));

            // Broadcast updated display list to admin clients
            this.broadcastDisplayList();

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(displayId, data);
                } catch (e) {
                    console.error('[Kiosk] Invalid message:', e);
                }
            });

            ws.on('close', () => {
                console.log(`[Kiosk] Display disconnected: ${displayId}`);
                this.displays.delete(displayId);
                this.broadcastDisplayList();
            });

            ws.on('pong', () => {
                const display = this.displays.get(displayId);
                if (display) display.lastSeen = Date.now();
            });
        });

        // Heartbeat to detect dead connections
        setInterval(() => {
            this.wss.clients.forEach(ws => {
                if (ws.isAlive === false) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);

        console.log('[Kiosk] WebSocket server initialized on /kiosk-ws');

        // Load content library
        this.loadContentLibrary();

        // Load promotions
        this.loadPromotions();

        // Load Shopify slideshows
        this.loadShopifySlideshows();

        // Load service slides
        this.loadServiceSlides();
    }

    generateDisplayId() {
        return 'disp_' + Math.random().toString(36).substr(2, 9);
    }

    handleMessage(displayId, data) {
        const display = this.displays.get(displayId);
        if (!display) return;

        switch (data.type) {
            case 'rename':
                display.name = data.name;
                this.broadcastDisplayList();
                break;

            case 'status':
                display.currentContent = data.content;
                display.lastSeen = Date.now();
                this.broadcastDisplayList();
                break;

            case 'admin-connect':
                // Mark this connection as an admin viewer
                display.isAdmin = true;
                this.sendToDisplay(displayId, {
                    type: 'admin-init',
                    displays: this.getDisplayList(),
                    contentLibrary: this.contentLibrary,
                    promotions: this.promotions,
                    shopifySlideshows: this.shopifySlideshows,
                    serviceSlides: this.serviceSlides,
                    rotatingEnabled: this.rotatingEnabled,
                    selectedSlideIds: this.selectedSlideIds
                });
                break;
        }
    }

    /**
     * Send content to a specific display
     */
    sendToDisplay(displayId, message) {
        const display = this.displays.get(displayId);
        if (display && display.ws.readyState === WebSocket.OPEN) {
            display.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Send content command to a display
     */
    setDisplayContent(displayId, content) {
        const display = this.displays.get(displayId);
        if (!display) return false;

        this.sendToDisplay(displayId, {
            type: 'show-content',
            content
        });

        display.currentContent = content;
        this.broadcastDisplayList();
        return true;
    }

    /**
     * Broadcast to all admin clients
     */
    broadcastDisplayList() {
        const displayList = this.getDisplayList();
        this.displays.forEach((display, id) => {
            if (display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'display-list',
                    displays: displayList
                });
            }
        });
    }

    getDisplayList() {
        const list = [];
        this.displays.forEach((display, id) => {
            if (!display.isAdmin) {
                list.push({
                    id,
                    name: display.name,
                    currentContent: display.currentContent,
                    lastSeen: display.lastSeen,
                    ip: display.ip,
                    online: Date.now() - display.lastSeen < 60000
                });
            }
        });
        return list;
    }

    /**
     * Load available content from content directory
     */
    loadContentLibrary() {
        // Default content types
        this.contentLibrary = [
            {
                id: 'welcome',
                type: 'builtin',
                name: 'Welcome Screen',
                description: 'Blue Ridge Custom Co welcome message'
            },
            {
                id: 'campaigns',
                type: 'campaigns',
                name: 'Campaigns Slideshow',
                description: 'Auto-rotating marketing campaigns'
            },
            {
                id: 'campaign-grid',
                type: 'campaign-grid',
                name: 'Campaign Grid',
                description: '12 random images in a grid, auto-rotating'
            },
            {
                id: 'qr-shop',
                type: 'builtin',
                name: 'Shop QR Code',
                description: 'QR code linking to Shopify store'
            },
            {
                id: 'rally',
                type: 'builtin',
                name: 'Swayze Rally Team',
                description: 'Rally team promo with #656'
            },
            {
                id: 'now-printing',
                type: 'live',
                name: 'Now Printing...',
                description: 'Shows current print job status'
            },
            {
                id: 'social',
                type: 'builtin',
                name: 'Social Feed',
                description: 'Social media handles and QR codes'
            }
        ];

        // Load campaigns and add each as a content option
        this.loadCampaigns();

        // Scan for custom kiosk content
        const customContentDir = path.join(__dirname, '..', '..', 'web', 'kiosk-content');
        if (fs.existsSync(customContentDir)) {
            try {
                fs.readdirSync(customContentDir).forEach(file => {
                    if (/\.(jpg|jpeg|png|gif|mp4|webm)$/i.test(file)) {
                        this.contentLibrary.push({
                            id: `custom-${file}`,
                            type: file.match(/\.(mp4|webm)$/i) ? 'video' : 'image',
                            name: file.replace(/\.[^.]+$/, ''),
                            description: 'Custom content',
                            url: `/kiosk-content/${file}`
                        });
                    }
                });
            } catch (e) {
                console.warn('[Kiosk] Could not scan kiosk-content directory:', e.message);
            }
        }

        console.log(`[Kiosk] Loaded ${this.contentLibrary.length} content items`);
    }

    /**
     * Load campaigns from the campaigns directory
     */
    loadCampaigns() {
        console.log(`[Kiosk] Looking for campaigns in: ${CAMPAIGNS_DIR}`);
        if (!fs.existsSync(CAMPAIGNS_DIR)) {
            console.log('[Kiosk] No campaigns directory found');
            return;
        }

        try {
            const files = fs.readdirSync(CAMPAIGNS_DIR);
            const campaigns = files
                .filter(name => name.endsWith('.json') && !name.includes('metrics'))
                .map(name => {
                    try {
                        const raw = fs.readFileSync(path.join(CAMPAIGNS_DIR, name), 'utf8');
                        return JSON.parse(raw);
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);

            // Add each campaign as a selectable content item
            campaigns.forEach(campaign => {
                if (campaign.slug && campaign.title) {
                    this.contentLibrary.push({
                        id: `campaign-${campaign.slug}`,
                        type: 'campaign',
                        name: `Campaign: ${campaign.title}`,
                        description: campaign.subtitle || 'Marketing campaign',
                        campaignSlug: campaign.slug,
                        campaign: campaign
                    });
                }
            });

            console.log(`[Kiosk] Loaded ${campaigns.length} campaigns`);
        } catch (e) {
            console.warn('[Kiosk] Could not load campaigns:', e.message);
        }
    }

    /**
     * Load promotions from the promotions directory
     */
    loadPromotions() {
        const indexFile = path.join(PROMOTIONS_DIR, 'promotions.json');
        try {
            if (fs.existsSync(indexFile)) {
                const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
                this.promotions = data.promotions || [];
                console.log(`[Kiosk] Loaded ${this.promotions.length} promotions`);
            } else {
                this.promotions = [];
                console.log('[Kiosk] No promotions file found');
            }
        } catch (e) {
            console.warn('[Kiosk] Could not load promotions:', e.message);
            this.promotions = [];
        }
    }

    /**
     * Save promotions to disk
     */
    savePromotions() {
        const indexFile = path.join(PROMOTIONS_DIR, 'promotions.json');
        try {
            fs.writeFileSync(indexFile, JSON.stringify({ promotions: this.promotions }, null, 2));
        } catch (e) {
            console.error('[Kiosk] Could not save promotions:', e.message);
        }
    }

    /**
     * Add a new promotion
     */
    addPromotion(promotion) {
        // Generate ID if not present
        if (!promotion.id) {
            promotion.id = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        }
        promotion.createdAt = promotion.createdAt || Date.now();
        promotion.enabled = promotion.enabled !== false;
        promotion.priority = promotion.priority || 1; // Higher = shown more often
        promotion.targetDisplays = promotion.targetDisplays || []; // Empty = all displays

        this.promotions.push(promotion);
        this.savePromotions();
        this.broadcastPromotions();
        return promotion;
    }

    /**
     * Update an existing promotion
     */
    updatePromotion(promoId, updates) {
        const index = this.promotions.findIndex(p => p.id === promoId);
        if (index === -1) return null;

        this.promotions[index] = { ...this.promotions[index], ...updates };
        this.savePromotions();
        this.broadcastPromotions();
        return this.promotions[index];
    }

    /**
     * Delete a promotion
     */
    deletePromotion(promoId) {
        const index = this.promotions.findIndex(p => p.id === promoId);
        if (index === -1) return false;

        // Delete associated image file if it's in our promotions folder
        const promo = this.promotions[index];
        if (promo.imageFile) {
            const imagePath = path.join(PROMOTIONS_DIR, promo.imageFile);
            try {
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (e) {
                console.warn('[Kiosk] Could not delete promo image:', e.message);
            }
        }

        this.promotions.splice(index, 1);
        this.savePromotions();
        this.broadcastPromotions();
        return true;
    }

    /**
     * Get promotions for a specific display
     */
    getPromotionsForDisplay(displayId) {
        return this.promotions.filter(p => {
            if (!p.enabled) return false;
            // Check expiration
            if (p.expiresAt && Date.now() > p.expiresAt) return false;
            // Check start time
            if (p.startsAt && Date.now() < p.startsAt) return false;
            // Check target displays (empty = all)
            if (p.targetDisplays && p.targetDisplays.length > 0) {
                return p.targetDisplays.includes(displayId);
            }
            return true;
        });
    }

    /**
     * Broadcast promotions to admin clients
     */
    broadcastPromotions() {
        this.displays.forEach((display, id) => {
            if (display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'promotions-list',
                    promotions: this.promotions
                });
            }
        });
    }

    /**
     * Get promotions directory path (for file uploads)
     */
    getPromotionsDir() {
        return PROMOTIONS_DIR;
    }

    // ========================================
    // Shopify Slideshows
    // ========================================

    /**
     * Load Shopify slideshows from disk
     */
    loadShopifySlideshows() {
        try {
            if (fs.existsSync(SHOPIFY_SLIDESHOWS_FILE)) {
                const data = JSON.parse(fs.readFileSync(SHOPIFY_SLIDESHOWS_FILE, 'utf8'));
                this.shopifySlideshows = data.slideshows || [];
                console.log(`[Kiosk] Loaded ${this.shopifySlideshows.length} Shopify slideshows`);

                // Add each slideshow to content library
                this.shopifySlideshows.forEach(ss => {
                    this.contentLibrary.push({
                        id: `shopify-${ss.id}`,
                        type: 'shopify-slideshow',
                        name: ss.name,
                        description: `${ss.products.length} products from ${ss.collectionTitle || 'Shopify'}`,
                        slideshow: ss
                    });
                });
            } else {
                this.shopifySlideshows = [];
                console.log('[Kiosk] No Shopify slideshows file found');
            }
        } catch (e) {
            console.warn('[Kiosk] Could not load Shopify slideshows:', e.message);
            this.shopifySlideshows = [];
        }
    }

    /**
     * Save Shopify slideshows to disk
     */
    saveShopifySlideshowsToFile() {
        try {
            fs.writeFileSync(SHOPIFY_SLIDESHOWS_FILE, JSON.stringify({ slideshows: this.shopifySlideshows }, null, 2));
        } catch (e) {
            console.error('[Kiosk] Could not save Shopify slideshows:', e.message);
        }
    }

    /**
     * Save a new Shopify slideshow configuration
     */
    saveShopifySlideshow(data) {
        const slideshow = {
            id: 'shopify_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            name: data.name || 'Shopify Slideshow',
            collectionId: data.collectionId,
            collectionTitle: data.collectionTitle,
            products: data.products || [], // Array of { id, title, image, handle }
            duration: data.duration || 6, // Seconds per product
            targetDisplays: data.targetDisplays || [],
            createdAt: Date.now()
        };

        this.shopifySlideshows.push(slideshow);
        this.saveShopifySlideshowsToFile();

        // Add to content library
        this.contentLibrary.push({
            id: `shopify-${slideshow.id}`,
            type: 'shopify-slideshow',
            name: slideshow.name,
            description: `${slideshow.products.length} products from ${slideshow.collectionTitle || 'Shopify'}`,
            slideshow: slideshow
        });

        this.broadcastContentLibrary();
        this.broadcastShopifySlideshows();

        return slideshow;
    }

    /**
     * Get all Shopify slideshows
     */
    getShopifySlideshows() {
        return this.shopifySlideshows;
    }

    /**
     * Delete a Shopify slideshow
     */
    deleteShopifySlideshow(slideshowId) {
        const index = this.shopifySlideshows.findIndex(ss => ss.id === slideshowId);
        if (index === -1) return false;

        this.shopifySlideshows.splice(index, 1);
        this.saveShopifySlideshowsToFile();

        // Remove from content library
        const contentIndex = this.contentLibrary.findIndex(c => c.id === `shopify-${slideshowId}`);
        if (contentIndex !== -1) {
            this.contentLibrary.splice(contentIndex, 1);
        }

        this.broadcastContentLibrary();
        this.broadcastShopifySlideshows();

        return true;
    }

    /**
     * Broadcast Shopify slideshows to admin clients
     */
    broadcastShopifySlideshows() {
        this.displays.forEach((display, id) => {
            if (display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'shopify-slideshows',
                    slideshows: this.shopifySlideshows
                });
            }
        });
    }

    /**
     * Add custom content (image/video)
     */
    addContent(item) {
        this.contentLibrary.push(item);
        this.broadcastContentLibrary();
    }

    broadcastContentLibrary() {
        this.displays.forEach((display, id) => {
            if (display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'content-library',
                    contentLibrary: this.contentLibrary
                });
            }
        });
    }

    // ========================================
    // Rotating Service Slides
    // ========================================

    /**
     * Load service slide HTML files from web directory
     */
    loadServiceSlides() {
        const webDir = path.join(__dirname, '..', '..', 'web');
        try {
            const files = fs.readdirSync(webDir);
            this.serviceSlides = files
                .filter(f => f.startsWith('slide-') && f.endsWith('.html'))
                .map(f => ({
                    id: f.replace('.html', ''),
                    filename: f,
                    url: `/${f}`,
                    name: f.replace('slide-', '').replace('.html', '').replace(/-/g, ' ')
                        .replace(/\b\w/g, c => c.toUpperCase())
                }));
            console.log(`[Kiosk] Loaded ${this.serviceSlides.length} service slides:`, this.serviceSlides.map(s => s.name).join(', '));
        } catch (e) {
            console.warn('[Kiosk] Could not load service slides:', e.message);
            this.serviceSlides = [];
        }
    }

    /**
     * Enable/disable rotating slides across displays
     * @param {boolean} enabled - Whether to enable rotation
     * @param {string[]|null} selectedSlides - Array of slide IDs to include, or null for all
     */
    setRotatingEnabled(enabled, selectedSlides = null) {
        this.rotatingEnabled = enabled;
        this.selectedSlideIds = selectedSlides;
        console.log(`[Kiosk] Rotating slides ${enabled ? 'ENABLED' : 'DISABLED'}, selected: ${selectedSlides ? selectedSlides.length : 'all'}`);

        if (enabled) {
            this.startSlideRotation();
        } else {
            this.stopSlideRotation();
        }

        // Broadcast state change to admins
        this.broadcastRotatingState();
    }

    /**
     * Get the slides that should be used for rotation
     */
    getActiveSlides() {
        if (!this.selectedSlideIds || this.selectedSlideIds.length === 0) {
            return this.serviceSlides;
        }
        return this.serviceSlides.filter(s => this.selectedSlideIds.includes(s.id));
    }

    /**
     * Start the slide rotation system
     * Cycles: show slide (6s) -> hide slide / show campaign (5-8s) -> show next slide
     */
    startSlideRotation() {
        // Clear any existing rotation
        if (this.rotationInterval) {
            clearTimeout(this.rotationInterval);
        }
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
        }

        // Configuration
        const slideDisplayDuration = 6000;      // How long to show each slide
        const campaignDisplayMin = 10000;       // Min time to show campaign content (10s)
        const campaignDisplayMax = 14000;       // Max time to show campaign content (14s)

        const showNextSlide = () => {
            if (!this.rotatingEnabled) return;

            // Show a slide
            this.rotateSlides();

            // Schedule hiding the slide after display duration
            this.hideTimeout = setTimeout(() => {
                if (!this.rotatingEnabled) return;

                // Hide slides on all displays to let campaign show through
                this.displays.forEach((display, id) => {
                    if (!display.isAdmin) {
                        this.sendToDisplay(id, {
                            type: 'hide-service-slide'
                        });
                    }
                });

                console.log('[Kiosk] Hiding slides, showing campaign content');

                // Schedule showing the next slide after campaign display time
                const campaignDuration = campaignDisplayMin + Math.random() * (campaignDisplayMax - campaignDisplayMin);
                this.rotationInterval = setTimeout(showNextSlide, campaignDuration);

            }, slideDisplayDuration);
        };

        // Start the cycle
        showNextSlide();
    }

    /**
     * Stop the slide rotation system
     */
    stopSlideRotation() {
        if (this.rotationInterval) {
            clearTimeout(this.rotationInterval);
            this.rotationInterval = null;
        }
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }

        // Clear all slide assignments but don't change display content
        this.slideAssignments.clear();

        // Tell displays to hide their slides
        this.displays.forEach((display, id) => {
            if (!display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'hide-service-slide'
                });
            }
        });
    }

    /**
     * Rotate slides across displays ensuring no duplicates
     */
    rotateSlides() {
        const activeSlides = this.getActiveSlides();
        if (activeSlides.length === 0) return;

        // Get list of non-admin displays
        const displayIds = [];
        this.displays.forEach((display, id) => {
            if (!display.isAdmin) {
                displayIds.push(id);
            }
        });

        if (displayIds.length === 0) return;

        // Shuffle slides to randomize assignment
        const shuffledSlides = [...activeSlides].sort(() => Math.random() - 0.5);

        // Clear previous assignments
        this.slideAssignments.clear();

        // Assign one slide per display (ensuring no duplicates across displays)
        const usedSlides = new Set();

        displayIds.forEach((displayId, index) => {
            // Find an unused slide
            let slide = null;
            for (const s of shuffledSlides) {
                if (!usedSlides.has(s.id)) {
                    slide = s;
                    usedSlides.add(s.id);
                    break;
                }
            }

            // If all slides are used (more displays than slides), cycle through
            if (!slide && shuffledSlides.length > 0) {
                slide = shuffledSlides[index % shuffledSlides.length];
            }

            if (slide) {
                this.slideAssignments.set(displayId, slide);

                // Send slide to display
                this.sendToDisplay(displayId, {
                    type: 'show-service-slide',
                    slide: slide,
                    duration: 6 // Minimum 6 seconds
                });
            }
        });

        console.log(`[Kiosk] Rotated slides:`, Array.from(this.slideAssignments.entries()).map(([d, s]) => `${d}:${s.name}`).join(', '));
    }

    /**
     * Broadcast rotating state to admin clients
     */
    broadcastRotatingState() {
        this.displays.forEach((display, id) => {
            if (display.isAdmin) {
                this.sendToDisplay(id, {
                    type: 'rotating-state',
                    enabled: this.rotatingEnabled,
                    serviceSlides: this.serviceSlides,
                    selectedSlideIds: this.selectedSlideIds
                });
            }
        });
    }

    /**
     * HTTP API handlers for integration with save-design-server.js
     */
    getApiHandlers() {
        return {
            // GET /api/kiosk/displays
            getDisplays: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ displays: this.getDisplayList() }));
            },

            // GET /api/kiosk/content
            getContent: (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ content: this.contentLibrary }));
            },

            // POST /api/kiosk/display/:id/content
            setContent: (req, res, displayId, body) => {
                const success = this.setDisplayContent(displayId, body.content);
                res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success }));
            },

            // POST /api/kiosk/display/:id/rename
            renameDisplay: (req, res, displayId, body) => {
                const display = this.displays.get(displayId);
                if (display) {
                    display.name = body.name;
                    this.broadcastDisplayList();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Display not found' }));
                }
            },

            // POST /api/kiosk/broadcast
            broadcast: (req, res, body) => {
                // Send same content to all displays
                this.displays.forEach((display, id) => {
                    if (!display.isAdmin) {
                        this.setDisplayContent(id, body.content);
                    }
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            }
        };
    }
}

module.exports = new KioskManager();
