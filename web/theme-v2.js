/* ═══════════════════════════════════════════════════════════════════
   theme-v2.js — BlueRidgeCustomCo Shared Theme JavaScript
   Header scroll, hamburger, scroll reveal, animated counter,
   floating CTA, and footer year.
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Header scroll effect ───────────────────────────────────────
  var header = document.getElementById('siteHeader');
  if (header) {
    window.addEventListener('scroll', function () {
      header.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });
  }

  // ─── Hamburger toggle ──────────────────────────────────────────
  var hamburger = document.getElementById('hamburger');
  var mobileNav = document.getElementById('mobileNav');

  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', function () {
      hamburger.classList.toggle('open');
      mobileNav.classList.toggle('open');
      document.body.style.overflow = mobileNav.classList.contains('open') ? 'hidden' : '';
    });

    mobileNav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        hamburger.classList.remove('open');
        mobileNav.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }

  // ─── Scroll reveal (IntersectionObserver) ──────────────────────
  var reveals = document.querySelectorAll('.reveal');
  if (reveals.length > 0 && 'IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    // Fallback: show everything if IntersectionObserver not supported
    reveals.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // ─── Animated counter ──────────────────────────────────────────
  function animateCount(el) {
    var target = parseInt(el.dataset.count, 10);
    if (!target) return;
    var duration = 1800;
    var start = performance.now();

    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(eased * target);
      el.textContent = current.toLocaleString() + '+';
      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  var counters = document.querySelectorAll('[data-count]');
  if (counters.length > 0 && 'IntersectionObserver' in window) {
    var counterObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          counterObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(function (el) {
      counterObserver.observe(el);
    });
  }

  // ─── Floating CTA visibility ───────────────────────────────────
  var floatingCta = document.getElementById('floatingCta');
  if (floatingCta && 'IntersectionObserver' in window) {
    // Try to observe .hero first; fall back to showing after scroll
    var heroSection = document.querySelector('.hero');
    if (heroSection) {
      var ctaObserver = new IntersectionObserver(function (entries) {
        floatingCta.classList.toggle('visible', !entries[0].isIntersecting);
      }, { threshold: 0 });
      ctaObserver.observe(heroSection);
    } else {
      // No hero on this page — show CTA after scrolling past 600px
      window.addEventListener('scroll', function () {
        floatingCta.classList.toggle('visible', window.scrollY > 600);
      }, { passive: true });
    }
  }

  // ─── Year in footer ────────────────────────────────────────────
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

})();
