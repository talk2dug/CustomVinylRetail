'use strict';
// ============================================================================
// PRINT QUOTES VIEW
// Manages the Print Quotes tab — list, detail, plate editor, print/export
// ============================================================================

(function () {

  let pqInitialized = false;
  let pqState = {
    quotes: [],
    activeQuoteId: null,
    detail: null // { quote, items, plates }
  };

  // ---- Public init (called when tab is activated) -------------------------

  window.initPrintQuotesView = function () {
    if (pqInitialized) {
      pqRefreshList();
      return;
    }
    pqInitialized = true;

    document.getElementById('pqNewQuoteBtn').addEventListener('click', pqShowNewQuoteDialog);
    document.getElementById('pqSearchBox').addEventListener('input', pqFilterList);

    pqRefreshList();
  };

  // ---- List ---------------------------------------------------------------

  async function pqRefreshList() {
    try {
      const res = await printStation.printQuotes.list({ limit: 200 });
      pqState.quotes = res.quotes || [];
      pqRenderList(pqState.quotes);
    } catch (err) {
      console.error('[PrintQuotes] list error', err);
    }
  }

  function pqFilterList() {
    const q = (document.getElementById('pqSearchBox').value || '').toLowerCase();
    const filtered = q
      ? pqState.quotes.filter(qt =>
          (qt.project_name || '').toLowerCase().includes(q) ||
          (qt.customer_name || '').toLowerCase().includes(q) ||
          (qt.status || '').toLowerCase().includes(q))
      : pqState.quotes;
    pqRenderList(filtered);
  }

  function pqRenderList(quotes) {
    const el = document.getElementById('pqQuoteList');
    if (!el) return;
    if (!quotes.length) {
      el.innerHTML = `<div style="padding:16px;color:#555;font-size:13px;text-align:center;">No quotes yet.</div>`;
      return;
    }
    el.innerHTML = quotes.map(qt => {
      const isActive = qt.id === pqState.activeQuoteId;
      const statusColor = { draft: '#888', ready: '#2196f3', printing: '#ff9800', done: '#4caf50', sent: '#9c27b0' }[qt.status] || '#888';
      const total = qt.total_cents ? `$${(qt.total_cents / 100).toFixed(2)}` : '';
      const date = qt.created_at ? new Date(qt.created_at).toLocaleDateString() : '';
      return `<div class="pq-list-item${isActive ? ' active' : ''}" data-id="${qt.id}" style="
        padding:10px 14px;cursor:pointer;border-bottom:1px solid #1a1a2e;
        background:${isActive ? '#1a2040' : 'transparent'};
        border-left:3px solid ${isActive ? '#2196f3' : 'transparent'};
      ">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escHtml(qt.project_name || 'Untitled')}
        </div>
        <div style="font-size:11px;color:#888;margin-top:2px;">${escHtml(qt.customer_name || '—')}</div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;">
          <span style="color:${statusColor};text-transform:uppercase;letter-spacing:0.5px;">${qt.status}</span>
          <span style="color:#aaa;">${total}${date ? ' · ' + date : ''}</span>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('.pq-list-item').forEach(item => {
      item.addEventListener('click', () => pqSelectQuote(parseInt(item.dataset.id, 10)));
    });
  }

  // ---- Detail -------------------------------------------------------------

  async function pqSelectQuote(id) {
    pqState.activeQuoteId = id;
    pqFilterList(); // re-render list to update active highlight

    try {
      const res = await printStation.printQuotes.get(id);
      pqState.detail = res;
      pqRenderDetail(res);
    } catch (err) {
      console.error('[PrintQuotes] get error', err);
    }
  }

  function pqRenderDetail({ quote, items, plates }) {
    document.getElementById('pqEmptyState').style.display = 'none';
    const panel = document.getElementById('pqDetail');
    panel.style.display = 'block';

    const statusOptions = ['draft', 'ready', 'printing', 'done', 'sent']
      .map(s => `<option value="${s}"${quote.status === s ? ' selected' : ''}>${s}</option>`)
      .join('');

    const serviceLevelLabels = {
      local: 'Print Locally',
      provider: 'Send to Provider'
    };

    const stlItems = items.filter(i => !i.missing_stl);
    const missingItems = items.filter(i => i.missing_stl);

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <div>
          <h3 style="margin:0;font-size:1.2rem;">${escHtml(quote.project_name || 'Untitled')}</h3>
          <div style="font-size:12px;color:#888;margin-top:2px;">Quote #${quote.id} · ${quote.source || 'manual'} · created ${new Date(quote.created_at).toLocaleString()}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="pqStatusSelect" style="padding:6px 10px;font-size:13px;">${statusOptions}</select>
          <button id="pqDeleteBtn" class="secondary" style="padding:6px 12px;font-size:12px;color:#e53935;">Delete</button>
        </div>
      </div>

      <!-- Customer Info -->
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="background:#111827;border-radius:6px;padding:12px 16px;flex:1;min-width:180px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Customer</div>
          <div style="font-size:13px;">${escHtml(quote.customer_name || '—')}</div>
          <div style="font-size:12px;color:#888;">${escHtml(quote.email || '')}${quote.phone ? ' · ' + escHtml(quote.phone) : ''}</div>
        </div>
        <div style="background:#111827;border-radius:6px;padding:12px 16px;flex:1;min-width:180px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Service</div>
          <div style="font-size:13px;">${serviceLevelLabels[quote.service_level] || quote.service_level}</div>
          <div style="font-size:12px;color:#aaa;">Total: <strong>$${(quote.total_cents / 100).toFixed(2)}</strong></div>
        </div>
      </div>

      <!-- Items Table -->
      <div style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h4 style="margin:0;font-size:0.95rem;">Items (${items.length})</h4>
        </div>
        ${stlItems.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="color:#888;font-size:11px;text-transform:uppercase;">
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #222;">Part</th>
              <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #222;">Qty</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #222;">Material</th>
              <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #222;">Price</th>
            </tr>
          </thead>
          <tbody>
            ${stlItems.map(it => `<tr>
              <td style="padding:6px 8px;border-bottom:1px solid #1a1a2e;">${escHtml(it.name)}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #1a1a2e;text-align:center;">${it.qty}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #1a1a2e;color:#aaa;">${it.material || 'PLA'}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #1a1a2e;text-align:right;color:#aaa;">$${((it.unit_price_cents * it.qty) / 100).toFixed(2)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p style="color:#555;font-size:13px;">No printable items.</p>'}

        ${missingItems.length ? `
        <div style="margin-top:12px;background:#1a1200;border:1px solid #3a2800;border-radius:6px;padding:12px 14px;">
          <div style="font-size:12px;color:#ff9800;font-weight:600;margin-bottom:8px;">⚠ Items Without STL Files</div>
          ${missingItems.map(it => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #2a1e00;font-size:12px;">
            <span style="color:#ccc;">${escHtml(it.name)} ×${it.qty}</span>
            ${it.search_hint ? `<a href="#" class="pq-parts-search-link" data-hint="${escHtml(it.search_hint)}"
              style="color:#2196f3;text-decoration:none;font-size:11px;white-space:nowrap;">🔍 Find Part →</a>` : ''}
          </div>`).join('')}
        </div>` : ''}
      </div>

      <!-- Plates Section -->
      <div style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h4 style="margin:0;font-size:0.95rem;">Build Plates (${plates.length})</h4>
          <div style="display:flex;gap:8px;">
            <select id="pqPrinterModelSel" style="padding:5px 8px;font-size:12px;">
              <option value="default">Default Bed (220×220)</option>
              <option value="ke">Kobra 3 (220×220)</option>
              <option value="s1pro">Bambu S1 Pro (256×256)</option>
            </select>
            <button id="pqPackBtn" class="primary" style="padding:6px 14px;font-size:12px;">Auto-Pack Plates</button>
          </div>
        </div>
        <div id="pqPlatesContainer">
          ${plates.length ? pqRenderPlates(plates, items) : '<p style="color:#555;font-size:13px;">No plates yet — click Auto-Pack Plates to generate.</p>'}
        </div>
      </div>

      <!-- Action Bar -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;padding-top:12px;border-top:1px solid #222;">
        ${quote.service_level === 'provider'
          ? `<button id="pqExportZipBtn" class="primary" style="padding:8px 18px;">Export G-code ZIP</button>`
          : `<button id="pqPrintLocalBtn" class="primary" style="padding:8px 18px;">Send to Slicer</button>`}
      </div>

      ${quote.notes ? `<div style="margin-top:16px;background:#111827;border-radius:6px;padding:12px 14px;font-size:13px;color:#aaa;">
        <strong style="color:#ddd;">Notes:</strong> ${escHtml(quote.notes)}
      </div>` : ''}
    `;

    // Wire events
    document.getElementById('pqStatusSelect').addEventListener('change', async (e) => {
      await printStation.printQuotes.update(quote.id, { status: e.target.value });
      pqRefreshList();
    });

    document.getElementById('pqDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete quote "${quote.project_name || 'Untitled'}"?`)) return;
      await printStation.printQuotes.delete(quote.id);
      pqState.activeQuoteId = null;
      document.getElementById('pqDetail').style.display = 'none';
      document.getElementById('pqEmptyState').style.display = '';
      pqRefreshList();
    });

    document.getElementById('pqPackBtn').addEventListener('click', async () => {
      const printer = document.getElementById('pqPrinterModelSel').value;
      const btn = document.getElementById('pqPackBtn');
      btn.disabled = true;
      btn.textContent = 'Packing…';
      try {
        const res = await printStation.printQuotes.packPlates(quote.id, printer);
        document.getElementById('pqPlatesContainer').innerHTML =
          pqRenderPlates(res.plates || [], items);
        pqWirePlateEvents(quote.id, res.plates || [], items);
      } catch (err) {
        alert('Packing failed: ' + (err.message || err));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Auto-Pack Plates';
      }
    });

    // Parts Browser search links — open slide-in drawer
    panel.querySelectorAll('.pq-parts-search-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const hint = link.dataset.hint;
        if (typeof window.openPartsFinderDrawer === 'function') {
          window.openPartsFinderDrawer(hint);
        } else if (typeof window.mpbOpenSearch === 'function') {
          window.mpbOpenSearch(hint);
        }
      });
    });

    const exportBtn = document.getElementById('pqExportZipBtn');
    if (exportBtn) exportBtn.addEventListener('click', () => pqExportGcodeZip(quote, plates));

    const printLocalBtn = document.getElementById('pqPrintLocalBtn');
    if (printLocalBtn) printLocalBtn.addEventListener('click', () => pqSendToSlicer(quote, items, plates));

    pqWirePlateEvents(quote.id, plates, items);
  }

  function pqRenderPlates(plates, items) {
    if (!plates.length) return '<p style="color:#555;font-size:13px;">No plates yet — click Auto-Pack Plates to generate.</p>';

    const itemMap = {};
    (items || []).forEach(i => { itemMap[i.id] = i; });

    return plates.map((plate, idx) => {
      let stlItemIds = [];
      try { stlItemIds = JSON.parse(plate.stl_item_ids || '[]'); } catch (_) {}

      const statusColor = { pending: '#888', sliced: '#2196f3', printing: '#ff9800', done: '#4caf50' }[plate.status] || '#888';

      const itemLines = stlItemIds.map(iid => {
        const it = itemMap[iid];
        return it ? `<span style="background:#1a1a2e;border-radius:3px;padding:2px 6px;font-size:11px;color:#ccc;">${escHtml(it.name)}</span>` : '';
      }).filter(Boolean).join(' ');

      return `<div class="pq-plate-card" data-plate-id="${plate.id}" style="
        background:#111827;border:1px solid #222;border-radius:8px;padding:12px 14px;margin-bottom:10px;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div style="font-weight:600;font-size:13px;">Plate ${plate.plate_index + 1} — ${plate.material}</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-size:11px;color:${statusColor};text-transform:uppercase;">${plate.status}</span>
            <select class="pq-plate-printer" data-plate-id="${plate.id}" style="font-size:12px;padding:4px 8px;">
              <option value="">— Assign Printer —</option>
            </select>
            <button class="pq-slice-plate-btn secondary" data-plate-id="${plate.id}"
              style="padding:4px 10px;font-size:12px;">
              Slice
            </button>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${itemLines}</div>
      </div>`;
    }).join('');
  }

  function pqWirePlateEvents(quoteId, plates, items) {
    // Populate printer dropdowns from fleet if available
    const printerSels = document.querySelectorAll('.pq-plate-printer');
    if (printerSels.length && window.printStation && printStation.printer) {
      (printStation.printer.list ? printStation.printer.list() : Promise.resolve([]))
        .then(printers => {
          printerSels.forEach(sel => {
            const cur = sel.value;
            printers.forEach(p => {
              const opt = document.createElement('option');
              opt.value = p.id || p.name;
              opt.textContent = p.name;
              if (cur === opt.value) opt.selected = true;
              sel.appendChild(opt);
            });
          });
        }).catch(() => {});
    }

    // Printer assignment change
    document.querySelectorAll('.pq-plate-printer').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const plateId = parseInt(sel.dataset.plateId, 10);
        await printStation.printQuotes.updatePlate(quoteId, plateId, { printer_id: e.target.value || null });
      });
    });

    // Slice button — sends plate items to the Slice & Print view
    document.querySelectorAll('.pq-slice-plate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const plateId = parseInt(btn.dataset.plateId, 10);
        const plate = plates.find(p => p.id === plateId);
        if (!plate) return;

        let stlItemIds = [];
        try { stlItemIds = JSON.parse(plate.stl_item_ids || '[]'); } catch (_) {}

        const plateItems = stlItemIds.map(iid => items.find(i => i.id === iid)).filter(Boolean);
        const slicerItems = plateItems
          .filter(it => it.stl_catalog_id)
          .map(it => ({ id: it.stl_catalog_id, name: it.name, qty: 1 }));

        if (!slicerItems.length) {
          alert('No sliceable items on this plate.');
          return;
        }

        // Switch to slicer view and pre-load the items
        if (typeof switchView === 'function') switchView('slicerView');
        setTimeout(() => {
          if (typeof slicerAddPlateItems === 'function') {
            slicerAddPlateItems(slicerItems);
          }
        }, 300);
      });
    });
  }

  // ---- Export G-code ZIP -------------------------------------------------

  async function pqExportGcodeZip(quote, plates) {
    const gcodeIds = plates.map(p => p.gcode_id).filter(Boolean);
    if (!gcodeIds.length) {
      alert('No sliced plates yet. Slice the plates first.');
      return;
    }
    alert('G-code ZIP export: slice each plate first via the Slicer view, then use the Slicer download button. Full automated zip coming soon.');
  }

  // ---- Send to Slicer ----------------------------------------------------

  async function pqSendToSlicer(quote, items, plates) {
    const stlItems = items.filter(i => !i.missing_stl && i.stl_catalog_id);
    if (!stlItems.length) {
      alert('No printable STL items in this quote.');
      return;
    }
    const slicerItems = stlItems.map(it => ({ id: it.stl_catalog_id, name: it.name, qty: it.qty }));
    if (typeof switchView === 'function') switchView('slicerView');
    setTimeout(() => {
      if (typeof slicerAddPlateItems === 'function') {
        slicerAddPlateItems(slicerItems);
      }
    }, 300);
  }

  // ---- New Quote Dialog --------------------------------------------------

  function pqShowNewQuoteDialog() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid #333;border-radius:8px;padding:24px;max-width:420px;width:90%;';
    modal.innerHTML = `
      <h3 style="margin:0 0 16px;">New Print Quote</h3>
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Project Name</label>
        <input id="pqNewProjectName" type="text" placeholder="e.g. Garage Organizer" style="width:100%;box-sizing:border-box;padding:8px 10px;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Customer Name</label>
        <input id="pqNewCustName" type="text" placeholder="John Doe" style="width:100%;box-sizing:border-box;padding:8px 10px;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Email</label>
        <input id="pqNewEmail" type="email" placeholder="customer@example.com" style="width:100%;box-sizing:border-box;padding:8px 10px;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Phone</label>
        <input id="pqNewPhone" type="tel" placeholder="828-555-1234" style="width:100%;box-sizing:border-box;padding:8px 10px;">
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Service</label>
        <select id="pqNewService" style="width:100%;padding:8px 10px;">
          <option value="local">Print Locally</option>
          <option value="provider">Send to Provider</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="pqNewCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
        <button id="pqNewSaveBtn" class="primary" style="padding:8px 16px;">Create Quote</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('#pqNewCancelBtn').addEventListener('click', () => document.body.removeChild(overlay));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });

    modal.querySelector('#pqNewSaveBtn').addEventListener('click', async () => {
      const data = {
        project_name: modal.querySelector('#pqNewProjectName').value.trim(),
        customer_name: modal.querySelector('#pqNewCustName').value.trim(),
        email: modal.querySelector('#pqNewEmail').value.trim(),
        phone: modal.querySelector('#pqNewPhone').value.trim(),
        service_level: modal.querySelector('#pqNewService').value,
        source: 'manual'
      };
      try {
        const res = await printStation.printQuotes.create(data);
        document.body.removeChild(overlay);
        await pqRefreshList();
        pqSelectQuote(res.quote.id);
      } catch (err) {
        alert('Failed to create quote: ' + (err.message || err));
      }
    });

    modal.querySelector('#pqNewProjectName').focus();
  }

  // ---- Helpers -----------------------------------------------------------

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Public API (for Multiboard Designer to save quotes) ---------------

  /**
   * Save a quote generated from the Multiboard Designer into the DB.
   * Called from multiboard-designer-view.js after mbOpenPrintableQuote().
   *
   * @param {object} opts
   * @param {string} opts.projectName
   * @param {string} opts.customerName
   * @param {string} opts.email
   * @param {string} opts.phone
   * @param {string} opts.serviceLevel
   * @param {number} opts.totalCents
   * @param {Array<{stl_catalog_id, part_id, name, qty, unit_price_cents, material, missing_stl, search_hint}>} opts.items
   * @returns {Promise<object>} saved quote
   */
  window.pqSaveMbQuote = async function ({
    projectName, customerName, email, phone, serviceLevel = 'local',
    totalCents = 0, items = []
  }) {
    try {
      const res = await printStation.printQuotes.create({
        source: 'multiboard',
        project_name: projectName,
        customer_name: customerName,
        email,
        phone,
        service_level: serviceLevel,
        total_cents: totalCents,
        items
      });
      await pqRefreshList();
      return res.quote;
    } catch (err) {
      console.error('[PrintQuotes] save MB quote error', err);
      throw err;
    }
  };

})();
