(function () {
  const READY_EVENT = 'minipaint-ready';
  const PARENT_ORIGIN = '*';
  const CANVAS_ID = 'canvas_minipaint';
  const CHECK_INTERVAL = 50;

  function postMessage(type, payload) {
    if (window.parent) {
      window.parent.postMessage({ type, payload }, PARENT_ORIGIN);
    }
  }

  function withMiniPaint(callback) {
    if (window.Layers && window.AppConfig && window.FileOpen && window.FileSave) {
      callback({
        Layers: window.Layers,
        AppConfig: window.AppConfig,
        FileOpen: window.FileOpen,
        FileSave: window.FileSave
      });
      return true;
    }
    return false;
  }

  function waitForMiniPaint(callback) {
    if (withMiniPaint(callback)) return;
    const timer = setInterval(() => {
      if (withMiniPaint((ctx) => {
        clearInterval(timer);
        callback(ctx);
      })) {
        return;
      }
    }, CHECK_INTERVAL);
  }

  function setCommonDimensions(commonDimensions) {
    try {
      if (!Array.isArray(commonDimensions) || !commonDimensions.length) return;
      const gui = window.Layers?.Base_gui;
      if (gui) {
        gui.common_dimensions = commonDimensions.map((entry) => [
          Number(entry.width) || 0,
          Number(entry.height) || 0,
          entry.label || `${entry.width}x${entry.height}`
        ]);
      }
    } catch (error) {
      console.warn('Unable to update miniPaint dimensions:', error);
    }
  }

  function setCanvasSize(width, height) {
    if (!width || !height) return;
    const w = Math.max(8, Math.round(width));
    const h = Math.max(8, Math.round(height));
    if (window.AppConfig) {
      window.AppConfig.WIDTH = w;
      window.AppConfig.HEIGHT = h;
      window.AppConfig.need_render = true;
      window.AppConfig.need_render_changed_params = true;
    }
    if (window.Layers) {
      try {
        window.Layers.Base_gui.prepare_canvas();
        window.Layers.stable_dimensions = [w, h];
        window.Layers.render(true);
      } catch (error) {
        console.warn('Unable to set miniPaint canvas size:', error);
      }
    }
  }

  function insertImage(url, options = {}) {
    if (!url) return;
    try {
      window.FileOpen.file_open_url_handler({ url });
      if (options.autoresize) {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          setCanvasSize(image.width, image.height);
        };
        image.src = url;
      }
    } catch (error) {
      console.warn('Unable to insert image:', error);
    }
  }

  function setFonts(fonts = []) {
    try {
      if (!Array.isArray(fonts) || !fonts.length) return;
      fonts.forEach((font) => {
        if (!font || !font.family) return;
        if (!window.AppConfig.FONTS.includes(font.family)) {
          window.AppConfig.FONTS.push(font.family);
        }
        if (font.weight) {
          window.AppConfig.user_fonts[font.family] = {
            variants: [{ fontFamily: font.family, fontStyle: font.style || 'normal', fontWeight: font.weight }]
          };
        }
      });
    } catch (error) {
      console.warn('Unable to register fonts:', error);
    }
  }

  function exportImage(format = 'image/png') {
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas) {
      postMessage('MINIPAINT_ERROR', { message: 'Canvas not found.' });
      return;
    }
    try {
      const dataUrl = canvas.toDataURL(format);
      postMessage('MINIPAINT_IMAGE', {
        dataUrl,
        format,
        width: canvas.width,
        height: canvas.height
      });
    } catch (error) {
      postMessage('MINIPAINT_ERROR', { message: error.message || String(error) });
    }
  }

  function handleMessage(event) {
    const { type, payload } = event.data || {};
    switch (type) {
      case 'MINIPAINT_SET_CANVAS':
        if (payload && payload.width && payload.height) {
          setCanvasSize(payload.width, payload.height);
        }
        break;
      case 'MINIPAINT_SET_DIMENSIONS':
        if (payload && Array.isArray(payload.dimensions)) {
          setCommonDimensions(payload.dimensions);
        }
        break;
      case 'MINIPAINT_INSERT_IMAGE':
        if (payload && payload.url) {
          insertImage(payload.url, payload.options || {});
        }
        break;
      case 'MINIPAINT_EXPORT':
        exportImage(payload?.format || 'image/png');
        break;
      case 'MINIPAINT_SET_FONTS':
        if (payload && Array.isArray(payload.fonts)) {
          setFonts(payload.fonts);
        }
        break;
      default:
        break;
    }
  }

  waitForMiniPaint(({ AppConfig }) => {
    window.addEventListener('message', handleMessage);
    document.body.classList.add('minipaint-embedded');
    postMessage('MINIPAINT_READY', {
      width: AppConfig.WIDTH,
      height: AppConfig.HEIGHT
    });
  });
})();
