function renderTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{([a-z0-9_]+)\}/gi, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

module.exports = { renderTemplate };

