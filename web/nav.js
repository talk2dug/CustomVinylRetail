(() => {
  if (document.querySelector('.site-nav')) return;

  const links = [
    { href: './index.html', label: 'Home', key: 'home' },
    { href: './decals.html', label: 'Decals', key: 'decals' },
    { href: './apparel.html', label: 'Apparel', key: 'apparel' },
    { href: './catalog.html', label: 'Catalog (All-in-one)', key: 'catalog' },
    { href: './mockups.html', label: 'Mockups', key: 'mockups' },
    { href: './custom-stickers.html', label: 'Custom Stickers', key: 'custom-stickers' },
    { href: './racing.html', label: 'Race Packages', key: 'racing' },
    { href: './customer.html', label: 'Customer Login', key: 'customer' }
  ];

  const styleId = 'site-nav-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .site-nav{position:sticky;top:0;z-index:1000;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:.5rem 1rem;font-family:Inter,Segoe UI,system-ui,-apple-system,sans-serif}
      .site-nav__brand{font-weight:700;color:#111827;text-decoration:none;margin-right:1rem}
      .site-nav__links{display:flex;gap:.75rem;flex-wrap:wrap}
      .site-nav__link{color:#1f2937;text-decoration:none;padding:.4rem .5rem;border-radius:.375rem}
      .site-nav__link:hover{background:#f3f4f6}
      .site-nav__link.active{color:#1d4ed8;font-weight:600;background:#eef2ff}
    `;
    document.head.appendChild(style);
  }

  const nav = document.createElement('div');
  nav.className = 'site-nav';
  const brand = document.createElement('a');
  brand.className = 'site-nav__brand';
  brand.href = './index.html';
  brand.textContent = "Swayze's Custom Vinyl";
  const list = document.createElement('nav');
  list.className = 'site-nav__links';

  const current = location.pathname.split('/').pop() || 'index.html';
  const activeKey = window.__PAGE_KEY__ || null;
  links.forEach((item) => {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    const isActive = activeKey ? (item.key === activeKey) : (current === item.href.replace('./',''));
    a.className = 'site-nav__link' + (isActive ? ' active' : '');
    list.appendChild(a);
  });

  nav.appendChild(brand);
  nav.appendChild(list);

  const target = document.body;
  if (target.firstChild) {
    target.insertBefore(nav, target.firstChild);
  } else {
    target.appendChild(nav);
  }
})();
