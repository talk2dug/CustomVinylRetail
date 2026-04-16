/**
 * nav-v2.js — Drop-in v2 header/footer for legacy pages
 *
 * Include this script on any old-theme page to replace its header and footer
 * with the Mountain Workshop v2 design. The page's main content area is untouched.
 *
 * Usage: <script src="./nav-v2.js" defer></script>
 */
(function() {
  'use strict';

  // ── Inject v2 fonts if not already present ──
  if (!document.querySelector('link[href*="Bricolage"]')) {
    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap';
    document.head.appendChild(fonts);
  }

  // ── Inject v2 nav styles ──
  const style = document.createElement('style');
  style.textContent = `
    /* ── V2 Nav Override ── */
    .v2-announce {
      background: #1B4332;
      color: #FAF8F5;
      text-align: center;
      padding: 0.6rem 1rem;
      font-family: 'DM Sans', -apple-system, sans-serif;
      font-size: 0.82rem;
      font-weight: 500;
      letter-spacing: 0.03em;
      z-index: 200;
      position: relative;
    }
    .v2-announce strong { font-weight: 700; }
    .v2-announce a { color: #E9C46A; text-decoration: underline; text-underline-offset: 2px; font-weight: 600; }
    .v2-announce i { margin-right: 0.35rem; }

    .v2-header {
      position: sticky !important;
      top: 0 !important;
      z-index: 150 !important;
      background: rgba(250, 248, 245, 0.92) !important;
      backdrop-filter: blur(20px) saturate(1.4) !important;
      -webkit-backdrop-filter: blur(20px) saturate(1.4) !important;
      border-bottom: 1px solid rgba(0,0,0,0.08) !important;
      transition: box-shadow 0.3s !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    .v2-header.scrolled { box-shadow: 0 4px 16px rgba(0,0,0,0.06) !important; }

    .v2-header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.9rem 0;
      max-width: 1200px;
      margin: 0 auto;
      padding-left: clamp(1.25rem, 4vw, 2.5rem);
      padding-right: clamp(1.25rem, 4vw, 2.5rem);
    }

    .v2-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: inherit;
    }
    .v2-logo-mark {
      width: 40px; height: 40px;
      background: #1B4332;
      border-radius: 10px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      position: relative;
      overflow: hidden;
    }
    .v2-logo-mark::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.15));
    }
    .v2-logo-mark i { color: #D4A373; font-size: 1rem; position: relative; z-index: 1; }
    .v2-logo-text {
      font-family: 'Bricolage Grotesque', Georgia, serif;
      font-weight: 700;
      font-size: 1.25rem;
      color: #2D2D2D;
      letter-spacing: -0.03em;
      line-height: 1.15;
    }
    .v2-logo-sub {
      display: block;
      font-family: 'DM Sans', sans-serif;
      font-size: 0.65rem;
      font-weight: 500;
      color: #8A8A8A;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .v2-nav {
      display: flex;
      align-items: center;
      gap: 0.15rem;
    }
    .v2-nav a {
      padding: 0.5rem 0.85rem;
      border-radius: 6px;
      font-family: 'DM Sans', sans-serif;
      font-weight: 500;
      font-size: 0.88rem;
      color: #5C5C5C;
      text-decoration: none;
      transition: color 0.2s, background 0.2s;
    }
    .v2-nav a:hover {
      color: #1A1A1A;
      background: rgba(0,0,0,0.04);
    }
    .v2-nav .v2-nav-cta {
      background: #1B4332 !important;
      color: #FAF8F5 !important;
      font-weight: 600 !important;
      padding: 0.5rem 1.2rem !important;
      border-radius: 100px !important;
      margin-left: 0.5rem;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .v2-nav .v2-nav-cta:hover {
      background: #2D6A4F !important;
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    }

    /* Hamburger */
    .v2-hamburger {
      display: none;
      flex-direction: column;
      gap: 5px;
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      z-index: 300;
    }
    .v2-hamburger span {
      display: block;
      width: 22px; height: 2px;
      background: #2D2D2D;
      border-radius: 2px;
      transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      transform-origin: center;
    }
    .v2-hamburger.open span:nth-child(1) { transform: rotate(45deg) translate(5px, 5px); }
    .v2-hamburger.open span:nth-child(2) { opacity: 0; transform: scaleX(0); }
    .v2-hamburger.open span:nth-child(3) { transform: rotate(-45deg) translate(5px, -5px); }

    .v2-mobile-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(250, 248, 245, 0.98);
      backdrop-filter: blur(30px);
      z-index: 250;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .v2-mobile-overlay.open { display: flex; }
    .v2-mobile-overlay a {
      font-family: 'Bricolage Grotesque', Georgia, serif;
      font-size: 1.5rem;
      font-weight: 600;
      color: #1A1A1A;
      padding: 0.75rem 2rem;
      border-radius: 10px;
      text-decoration: none;
      transition: color 0.2s, background 0.2s;
    }
    .v2-mobile-overlay a:hover {
      color: #1B4332;
      background: rgba(27, 67, 50, 0.08);
    }

    @media (max-width: 960px) {
      .v2-nav { display: none !important; }
      .v2-hamburger { display: flex !important; }
    }

    /* ── V2 Footer ── */
    .v2-footer {
      background: #2D2D2D !important;
      color: rgba(255,255,255,0.6) !important;
      padding: 4rem 0 2rem !important;
      font-family: 'DM Sans', -apple-system, sans-serif !important;
      border-top: none !important;
    }
    .v2-footer * { font-family: 'DM Sans', -apple-system, sans-serif; }
    .v2-footer-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 clamp(1.25rem, 4vw, 2.5rem);
    }
    .v2-footer-grid {
      display: grid;
      grid-template-columns: 1.6fr repeat(3, 1fr);
      gap: 3rem;
      margin-bottom: 3rem;
    }
    .v2-footer .v2-logo-text { color: #fff; }
    .v2-footer .v2-logo-sub { color: rgba(255,255,255,0.4); }
    .v2-footer-brand p {
      color: rgba(255,255,255,0.4);
      font-size: 0.85rem;
      line-height: 1.7;
      margin-top: 1rem;
      max-width: 280px;
    }
    .v2-footer-col h4 {
      font-family: 'Bricolage Grotesque', Georgia, serif;
      font-size: 0.8rem;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 1.25rem;
    }
    .v2-footer-col a {
      display: block;
      color: rgba(255,255,255,0.45);
      font-size: 0.85rem;
      padding: 0.3rem 0;
      transition: color 0.2s;
      text-decoration: none;
    }
    .v2-footer-col a:hover { color: #D4A373; }
    .v2-footer-social {
      display: flex;
      gap: 0.6rem;
      margin-top: 1.5rem;
    }
    .v2-footer-social a {
      width: 34px; height: 34px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.5);
      font-size: 0.85rem;
      transition: all 0.2s;
      padding: 0;
    }
    .v2-footer-social a:hover {
      color: #D4A373;
      border-color: #D4A373;
      transform: translateY(-2px);
    }
    .v2-footer-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 2rem;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 0.78rem;
      color: rgba(255,255,255,0.3);
      flex-wrap: wrap;
      gap: 1rem;
    }
    .v2-footer-trust {
      display: flex;
      gap: 1.25rem;
      align-items: center;
    }
    .v2-footer-trust span {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.72rem;
    }
    .v2-footer-trust i { color: #D4A373; font-size: 0.65rem; }

    @media (max-width: 800px) {
      .v2-footer-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 500px) {
      .v2-footer-grid { grid-template-columns: 1fr; }
      .v2-footer-bottom { flex-direction: column; text-align: center; }
    }
  `;
  document.head.appendChild(style);

  // ── HTML Templates ──
  const announceHTML = `
    <div class="v2-announce">
      <i class="fas fa-map-marker-alt"></i>
      <strong>Handmade in Asheville, NC</strong> &mdash; Fast shipping nationwide.
      <a href="./catalog-v2.html">Start shopping &rarr;</a>
    </div>`;

  const headerHTML = `
    <header class="v2-header" id="v2Header">
      <div class="v2-header-inner">
        <a href="./" class="v2-logo">
          <div class="v2-logo-mark"><i class="fas fa-mountain"></i></div>
          <div>
            <span class="v2-logo-text">BlueRidgeCustomCo</span>
            <span class="v2-logo-sub">Asheville's Custom Shop</span>
          </div>
        </a>
        <nav class="v2-nav">
          <a href="./catalog-v2.html">Stickers</a>
          <a href="./multiboard/">Multiboard</a>
          <a href="./apparel.html">Apparel</a>
          <a href="./metal-prints.html">Metal Prints</a>
          <a href="./slide-laser-engraving.html">Engraving</a>
          <a href="./racing.html">Racing</a>
          <a href="./designer.html" class="v2-nav-cta"><i class="fas fa-pen-nib"></i> Free Designer</a>
        </nav>
        <button class="v2-hamburger" id="v2Hamburger" aria-label="Toggle menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
    <div class="v2-mobile-overlay" id="v2MobileNav">
      <a href="./">Home</a>
      <a href="./catalog-v2.html">Stickers & Decals</a>
      <a href="./multiboard/">Multiboard</a>
      <a href="./apparel.html">Apparel</a>
      <a href="./metal-prints.html">Metal Prints</a>
      <a href="./slide-laser-engraving.html">Laser Engraving</a>
      <a href="./racing.html">Racing</a>
      <a href="./designer.html">Free Designer</a>
      <a href="./custom-stickers.html">Custom Orders</a>
      <a href="./customer.html">My Account</a>
    </div>`;

  const footerHTML = `
    <footer class="v2-footer">
      <div class="v2-footer-inner">
        <div class="v2-footer-grid">
          <div class="v2-footer-brand">
            <a href="./" class="v2-logo" style="margin-bottom:0;">
              <div class="v2-logo-mark"><i class="fas fa-mountain"></i></div>
              <div>
                <span class="v2-logo-text">BlueRidgeCustomCo</span>
                <span class="v2-logo-sub">Asheville's Custom Shop</span>
              </div>
            </a>
            <p>Vinyl decals, metal prints, 3D organizers, laser engraving & apparel. Handmade in Asheville, NC.</p>
            <div class="v2-footer-social">
              <a href="#" aria-label="Facebook"><i class="fab fa-facebook-f"></i></a>
              <a href="#" aria-label="Instagram"><i class="fab fa-instagram"></i></a>
              <a href="#" aria-label="TikTok"><i class="fab fa-tiktok"></i></a>
            </div>
          </div>
          <div class="v2-footer-col">
            <h4>Shop</h4>
            <a href="./catalog-v2.html">Stickers & Decals</a>
            <a href="./multiboard/">Multiboard</a>
            <a href="./apparel.html">Apparel</a>
            <a href="./metal-prints.html">Metal Prints</a>
            <a href="./slide-laser-engraving.html">Laser Engraving</a>
            <a href="./racing.html">Racing Packages</a>
          </div>
          <div class="v2-footer-col">
            <h4>Tools</h4>
            <a href="./designer.html">Free Designer</a>
            <a href="./custom-stickers.html">Custom Orders</a>
            <a href="./price-list.html">Price List</a>
            <a href="./customer.html">My Account</a>
          </div>
          <div class="v2-footer-col">
            <h4>Info</h4>
            <a href="./our-story.html">Our Story</a>
            <a href="./faq.html">FAQ</a>
            <a href="./contact.html">Contact</a>
            <a href="./privacy-policy.html">Privacy Policy</a>
            <a href="./terms.html">Terms & Conditions</a>
          </div>
        </div>
        <div class="v2-footer-bottom">
          <span>&copy; ${new Date().getFullYear()} BlueRidgeCustomCo. All rights reserved.</span>
          <div class="v2-footer-trust">
            <span><i class="fas fa-circle-check"></i> Secure checkout</span>
            <span><i class="fas fa-circle-check"></i> Made in USA</span>
            <span><i class="fas fa-circle-check"></i> Fast turnaround</span>
          </div>
        </div>
      </div>
    </footer>`;

  // ── Replace old header ──
  function replaceHeader() {
    // Remove old promo banner if present
    const promoBanner = document.querySelector('.promo-banner');
    if (promoBanner) promoBanner.remove();

    // Find and replace old header
    const oldHeader = document.querySelector('.site-header, header.site-header, #siteHeader');
    if (oldHeader) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = announceHTML + headerHTML;
      oldHeader.parentNode.insertBefore(wrapper, oldHeader);
      // Remove all children of wrapper and insert them directly
      while (wrapper.firstChild) {
        oldHeader.parentNode.insertBefore(wrapper.firstChild, wrapper);
      }
      wrapper.remove();
      oldHeader.remove();
    } else {
      // No old header — prepend to body
      document.body.insertAdjacentHTML('afterbegin', announceHTML + headerHTML);
    }

    // Remove old mobile nav
    const oldMobileNav = document.querySelector('.nav-mobile-overlay, #mobileNav');
    if (oldMobileNav) oldMobileNav.remove();
  }

  // ── Replace old footer ──
  function replaceFooter() {
    const oldFooter = document.querySelector('.site-footer, footer.site-footer');
    if (oldFooter) {
      oldFooter.outerHTML = footerHTML;
    } else {
      document.body.insertAdjacentHTML('beforeend', footerHTML);
    }
  }

  // ── Wire up interactions ──
  function wireUp() {
    // Header scroll
    const header = document.getElementById('v2Header');
    if (header) {
      window.addEventListener('scroll', function() {
        header.classList.toggle('scrolled', window.scrollY > 40);
      }, { passive: true });
    }

    // Hamburger
    const hamburger = document.getElementById('v2Hamburger');
    const mobileNav = document.getElementById('v2MobileNav');
    if (hamburger && mobileNav) {
      hamburger.addEventListener('click', function() {
        hamburger.classList.toggle('open');
        mobileNav.classList.toggle('open');
        document.body.style.overflow = mobileNav.classList.contains('open') ? 'hidden' : '';
      });
      mobileNav.querySelectorAll('a').forEach(function(a) {
        a.addEventListener('click', function() {
          hamburger.classList.remove('open');
          mobileNav.classList.remove('open');
          document.body.style.overflow = '';
        });
      });
    }
  }

  // ── Execute ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      replaceHeader();
      replaceFooter();
      wireUp();
    });
  } else {
    replaceHeader();
    replaceFooter();
    wireUp();
  }
})();
