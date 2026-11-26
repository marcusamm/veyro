// Present the native mailbox form inside Veyro's original webmail entry page.
(function () {
  function presentLogin() {
    const card = document.querySelector('.login-card.login-user');
    if (!card || document.querySelector('.veyro-entry-page')) return;
    const container = card.closest('.container');
    const controls = card.querySelector('.card-header');
    if (!container || !controls) return;

    const danish = /^da(?:-|$)/i.test(document.documentElement.lang);
    const english = /^en(?:-|$)/i.test(document.documentElement.lang);
    const el = (tag, name, text) => {
      const item = document.createElement(tag);
      item.className = name;
      if (text) item.textContent = text;
      return item;
    };
    function mark(size) {
      const image = el('img', 'veyro-mark');
      image.src = '/veyro-mail/mark.svg';
      image.width = image.height = size;
      image.alt = '';
      return image;
    }

    const page = el('div', 'veyro-entry-page');
    const bar = el('header', 'veyro-entry-bar');
    const brand = el('div', 'veyro-entry-brand');
    brand.append(mark(34), 'Veyro');
    const home = el('a', 'veyro-home');
    home.append(el('span', 'veyro-home-full', danish ? 'Veyros hjemmeside' : 'veyro.dk'),
      el('span', 'veyro-home-short', 'veyro.dk'));
    home.href = 'https://veyro.dk/';
    bar.append(brand, home, controls);

    const desk = el('main', 'veyro-entry-desk');
    const entry = el('section', 'veyro-entry');
    const title = el('h1', 'veyro-entry-title', 'Veyro Mail');
    title.id = 'veyro-entry-title';
    entry.setAttribute('aria-labelledby', title.id);
    const dot = el('span', '', '.');
    dot.setAttribute('aria-hidden', 'true');
    title.append(dot);
    entry.append(title);
    if (danish || english) {
      entry.append(el('p', 'veyro-entry-lead', danish
        ? 'Log ind med din Veyro-mailadresse for at læse og sende mail.'
        : 'Sign in with your Veyro email address to read and send mail.'));
    }

    const art = el('div', 'veyro-mail-art');
    art.setAttribute('aria-hidden', 'true');
    const envelope = el('div', 'veyro-envelope');
    envelope.append(el('div', 'veyro-envelope-flap'), mark(48), el('span', 'veyro-postmark', 'mail.veyro.dk'));
    art.append(envelope);
    desk.append(entry, art);
    page.append(bar, desk);
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    container.before(page);
    // Move the original subtree intact: password handlers, CSRF fields, MFA,
    // server errors and conditional authentication choices stay on their nodes.
    entry.append(container);
    if (focused) focused.focus({ preventScroll: true });
    const usernameField = card.querySelector('#login_user[autofocus]');
    if (usernameField && window.matchMedia('(max-width: 46rem)').matches) {
      usernameField.removeAttribute('autofocus');
      if (focused === usernameField && !location.hash) {
        requestAnimationFrame(() => {
          if (document.activeElement === usernameField) window.scrollTo(0, 0);
        });
      }
    }
    if (['post.veyro.dk', 'mail.veyro.dk'].includes(location.hostname)) {
      card.querySelector('a[href="/reset-password"]')?.closest('div')?.setAttribute('hidden', '');
      const directoryLink = card.parentElement.querySelector('p a[href="/admin"], p a[href="/domainadmin"]');
      directoryLink?.closest('p')?.setAttribute('hidden', '');
      // The gateway does not publish the optional passwordless API. Challenge
      // forms rendered after password authentication are separate from this link.
      const fido = card.querySelector('#fido2-login');
      if (fido) {
        fido.hidden = true;
        const alternatives = fido.closest('.flex-column');
        if (alternatives && !Array.from(alternatives.querySelectorAll('a,button')).some(item => !item.hidden)) {
          alternatives.hidden = true;
          if (alternatives.previousElementSibling?.matches('.hr-title')) {
            alternatives.previousElementSibling.hidden = true;
          }
        }
      }
    }
    const legend = card.querySelector('legend');
    if (legend && /^(post\.veyro\.dk - mail UI|Veyro Mail)$/i.test(legend.textContent.trim())) {
      legend.classList.add('visually-hidden');
    }
    document.title = 'Veyro Mail';
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) viewport.content = 'width=device-width, initial-scale=1';
    for (const icon of document.querySelectorAll('link[rel~="icon"]')) {
      icon.type = 'image/svg+xml';
      icon.href = '/veyro-mail/mark.svg';
    }
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = '#f4f2ec';

    function label(element, value) {
      if (!element) return;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          child.textContent = ' ' + value + ' ';
          return;
        }
      }
    }
    if (danish) {
      label(card.querySelector('label[for="login_user"]'), 'E-mailadresse');
      label(card.querySelector('a[href="/reset-password"]'), 'Glemt adgangskode?');
      label(card.querySelector('form button[type="submit"]'), 'Log ind');
      label(card.querySelector('#fido2-login'), 'Log ind med sikkerhedsnøgle');
      const username = card.querySelector('#login_user');
      if (username) username.placeholder = 'E-mailadresse';
      const footer = card.parentElement.querySelector('p a[href="/admin"], p a[href="/domainadmin"]')?.closest('p');
      if (footer) {
        label(footer, 'Administration');
        label(footer.querySelector('a[href="/admin"]'), 'Administrator');
        label(footer.querySelector('a[href="/domainadmin"]'), 'Domæneadministrator');
      }
    }
    const theme = controls.querySelector('#dark-mode-toggle');
    const languages = controls.querySelector('button[data-bs-toggle="dropdown"]');
    const reveal = card.querySelector('button[aria-label="Toggle password visibility"]');
    if (theme) theme.setAttribute('aria-label', danish ? 'Skift farvetema' : 'Change color theme');
    if (languages) languages.setAttribute('aria-label', danish ? 'Vælg sprog' : 'Language');
    if (reveal) {
      if (danish) reveal.setAttribute('aria-label', 'Vis eller skjul adgangskode');
      reveal.removeAttribute('tabindex');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', presentLogin, { once: true });
  else presentLogin();
})();
