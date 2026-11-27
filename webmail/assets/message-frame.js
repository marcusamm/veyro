(() => {
  'use strict';

  // This document has an opaque sandbox origin. The URL still identifies its trusted parent.
  const parentOrigin = new URL(location.href).origin;
  const imagePermission = new URL(location.href).searchParams.get('images') === '1';
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  const tags = new Set('a address article b bdi bdo blockquote br caption center code col colgroup dd del div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img li main mark ol p pre s section small span strong style sub sup table tbody td tfoot th thead tr u ul wbr'.split(' '));
  const attributes = new Set('class id title dir lang align valign bgcolor color face size width height cellpadding cellspacing border colspan rowspan nowrap role aria-label'.split(' '));
  let initialized = false, token = '', loadImages = false, scheduled = false, lastSize = '';

  function mailLinkUrl(value) {
    if (!value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
    try {
      const url = new URL(value);
      if (/^https?:\/\/[^/\\]/i.test(value) && url.hostname && !url.username && !url.password) return url;
      if (url.protocol === 'mailto:' && /^[^@/?#%\\,;:\s]+@[^@/?#%\\,;:\s]+$/u.test(url.pathname) &&
          !url.hash && !/%(?:00|0a|0d)/i.test(value) && [...url.searchParams.keys()].every(key => /^(?:subject|body)$/i.test(key))) return url;
    } catch { /* Unsupported destinations remain readable without a link. */ }
    return null;
  }

  function setLink(anchor, value) {
    const url = mailLinkUrl(value);
    if (!url) return;
    anchor.href = url.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.title = url.href;
  }

  function trimMailUrl(value) {
    let end = value.length;
    while (end && '.,!?:;'.includes(value[end - 1])) end--;
    const pairs = {')': '(', ']': '[', '}': '{'};
    const balance = {')': 0, ']': 0, '}': 0};
    for (const char of value.slice(0, end)) {
      if (Object.hasOwn(pairs, char)) balance[char]++;
      else if (char === '(') balance[')']--;
      else if (char === '[') balance[']']--;
      else if (char === '{') balance['}']--;
    }
    while (end && balance[value[end - 1]] > 0) { balance[value[end - 1]]--; end--; }
    return value.slice(0, end);
  }

  function appendText(parent, text, inLink) {
    if (inLink) { parent.append(document.createTextNode(text)); return; }
    const links = /(^|[\s([{<"'«“])((?:https?:\/\/|mailto:)[^\s<>"'»”]+)/giu;
    let offset = 0;
    for (const match of text.matchAll(links)) {
      const start = match.index + match[1].length;
      const value = trimMailUrl(match[2]);
      parent.append(document.createTextNode(text.slice(offset, start)));
      if (mailLinkUrl(value)) {
        const link = document.createElement('a');
        setLink(link, value); link.textContent = value; parent.append(link);
      } else parent.append(document.createTextNode(value));
      offset = start + value.length;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }

  function imageUrl(value, remote = loadImages) {
    if (typeof value !== 'string' || !value || value.length > 12 * 1024 * 1024) return null;
    if (/^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    if (!remote || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^https:\/\//i.test(value) || url.username || url.password || url.port && url.port !== '443') return null;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      // Local names and IP literals are never image destinations, even after consent.
      if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) ||
          /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|home|lan)$/.test(host)) return null;
      return url.href;
    } catch { return null; }
  }

  function safeDeclaration(style) {
    const output = document.createElement('span').style;
    for (const name of style) {
      let value = style.getPropertyValue(name);
      if (name === 'behavior' || name === '-moz-binding' || /[\\@\u0000-\u001f\u007f]/u.test(value) ||
          /(?:expression|(?:-webkit-)?image-set|image|src|paint)\s*\(/i.test(value)) continue;
      let invalid = false;
      value = value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, double, single, bare) => {
        const original = (double ?? single ?? bare).trim();
        const destination = imageUrl(original);
        if (destination) return 'url(' + JSON.stringify(destination) + ')';
        if (!loadImages && imageUrl(original, true)) return 'none';
        invalid = true;
        return 'none';
      });
      if (invalid || /url\s*\(/i.test(value.replace(/url\("[^"]*"\)/gi, ''))) continue;
      output.setProperty(name, value, style.getPropertyPriority(name));
    }
    return output.cssText;
  }

  function safeStylesheet(value) {
    try {
      // A constructed sheet is not adopted: parsing it cannot load sender resources.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(value);
      const copy = rules => [...rules].map(rule => {
        if (rule.type === CSSRule.STYLE_RULE) {
          const declaration = safeDeclaration(rule.style);
          return declaration ? rule.selectorText + '{' + declaration + '}' : '';
        }
        if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
          const contents = copy(rule.cssRules);
          return contents ? (rule.type === CSSRule.MEDIA_RULE ? '@media ' : '@supports ') + rule.conditionText + '{' + contents + '}' : '';
        }
        return ''; // No imports, font sources, namespaces, or other active at-rules.
      }).join('\n');
      return copy(sheet.cssRules);
    } catch { return ''; }
  }

  function copyAttributes(source, target) {
    for (const attribute of source.attributes) {
      const name = attribute.name, value = attribute.value;
      if (!attributes.has(name) || value.length > 4096) continue;
      if (['width', 'height', 'cellpadding', 'cellspacing', 'border', 'colspan', 'rowspan'].includes(name) && !/^\d{1,5}(?:\.\d{1,3})?%?$/.test(value)) continue;
      target.setAttribute(name, value);
    }
    const css = safeDeclaration(source.style);
    if (css) target.setAttribute('style', css);
  }

  function copyImage(source, inlineImages) {
    const part = source.getAttribute('data-veyro-part');
    const embedded = imageUrl(source.getAttribute('src'), false) || inlineImages.get(part);
    const external = source.getAttribute('data-veyro-src') || source.getAttribute('src');
    const destination = embedded || imageUrl(external);
    const alt = (source.getAttribute('alt') || '').slice(0, 4096);
    const image = document.createElement(destination ? 'img' : 'span');
    copyAttributes(source, image);
    if (destination) {
      image.src = destination;
      image.alt = alt;
      image.referrerPolicy = 'no-referrer';
      image.decoding = 'async';
    } else {
      image.classList.add('veyro-image-placeholder');
      image.setAttribute('role', 'img');
      image.setAttribute('aria-label', alt || 'Billede');
      image.title = alt ? 'Billede skjult · ' + alt : 'Billede skjult';
      image.textContent = alt;
      for (const name of ['width', 'height']) {
        const value = source.getAttribute(name);
        if (!image.style.getPropertyValue(name) && /^\d{1,5}(?:\.\d{1,3})?%?$/.test(value || ''))
          image.style.setProperty(name, value.endsWith('%') ? value : value + 'px');
      }
      if (!image.style.width) image.style.width = '100%';
      if (!image.style.height || image.style.height === 'auto') image.style.minHeight = '1.5em';
    }
    return image;
  }

  function render(html) {
    const inertDocument = document.implementation.createHTMLDocument('');
    const template = inertDocument.createElement('template');
    template.innerHTML = html;
    const inlineImages = new Map();
    for (const image of template.content.querySelectorAll('img[data-veyro-part]')) {
      const src = imageUrl(image.getAttribute('src'), false);
      const part = image.getAttribute('data-veyro-part');
      if (src && part && part.length <= 200 && !inlineImages.has(part)) inlineImages.set(part, src);
    }
    function copyChildren(source, target, inLink = false) {
      for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { appendText(target, child.data, inLink); continue; }
        if (child.namespaceURI !== htmlNamespace || !tags.has(child.localName)) continue;
        const tag = child.localName;
        if (tag === 'img') { target.append(copyImage(child, inlineImages)); continue; }
        const element = document.createElement(tag);
        if (tag === 'style') {
          element.textContent = safeStylesheet(child.textContent);
          const media = child.getAttribute('media');
          if (media && media.length <= 4096) element.media = media;
          if (element.textContent) target.append(element);
          continue;
        }
        copyAttributes(child, element);
        if (tag === 'a') setLink(element, child.getAttribute('href'));
        copyChildren(child, element, inLink || tag === 'a');
        target.append(element);
      }
    }
    const content = document.createDocumentFragment();
    copyChildren(template.content, content);
    document.body.replaceChildren(content);
  }

  function reportSize() {
    scheduled = false;
    if (!initialized) return;
    const rect = document.body.getBoundingClientRect();
    const style = getComputedStyle(document.body);
    const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    const scrollbar = Math.max(0, window.innerHeight - document.documentElement.clientHeight);
    const height = Math.ceil(Math.max(document.body.scrollHeight, rect.height, 1) + Math.max(0, margins) + scrollbar);
    const width = Math.ceil(Math.max(document.body.scrollWidth, rect.width, 1));
    const size = height + ':' + width;
    if (size === lastSize) return;
    lastSize = size;
    parent.postMessage({type: 'veyro-mail-size', token, height, width}, parentOrigin);
  }

  function scheduleSize() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(reportSize); }
  }

  function contextMenu(event, keyboard = false) {
    if (!initialized || event.defaultPrevented || event.target.closest?.('a[href]') || window.getSelection()?.toString()) return;
    event.preventDefault();
    parent.postMessage({type: 'veyro-mail-contextmenu', token,
      x: keyboard ? null : event.clientX, y: keyboard ? null : event.clientY}, parentOrigin);
  }

  document.addEventListener('contextmenu', event => contextMenu(event));
  document.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') contextMenu(event, true);
  });

  window.addEventListener('message', event => {
    const data = event.data;
    if (initialized || event.source !== parent || event.origin !== parentOrigin || !data || data.type !== 'veyro-mail-init' ||
        typeof data.token !== 'string' || !/^[a-f0-9]{32}$/.test(data.token) || typeof data.html !== 'string' ||
        data.html.length > 16 * 1024 * 1024 || typeof data.images !== 'boolean') return;
    initialized = true;
    token = data.token;
    loadImages = imagePermission && data.images;
    render(data.html);
    new ResizeObserver(scheduleSize).observe(document.body);
    document.addEventListener('load', scheduleSize, true);
    document.addEventListener('error', scheduleSize, true);
    window.addEventListener('resize', scheduleSize);
    scheduleSize();
  });

  if (parent !== window) parent.postMessage({type: 'veyro-mail-ready'}, parentOrigin);
})();
