// Keep authentication, language selection and MFA in mailcow's native form.
(function () {
  function presentLogin() {
    const card = document.querySelector('.login-card.login-user');
    if (!card) return;

    const danish = /^da(?:-|$)/i.test(document.documentElement.lang);
    for (const logo of card.querySelectorAll('.mailcow-logo img')) logo.alt = 'Veyro Mail';
    const favicon = document.querySelector('link[rel~="icon"]');
    if (favicon) {
      favicon.type = 'image/svg+xml';
      favicon.href = '/veyro-mail/mark.svg';
    }
    const legend = card.querySelector('legend');
    if (legend && /^(post\.veyro\.dk - mail UI|Veyro Mail)$/i.test(legend.textContent.trim())) {
      legend.textContent = danish ? 'Log ind' : 'Veyro Mail';
      document.title = danish ? 'Log ind · Veyro Mail' : 'Veyro Mail';
    }
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) viewport.content = 'width=device-width, initial-scale=1';
    if (!danish) return;

    // Translate only these labels. Leave native icons, links and controls intact.
    function label(element, value) {
      if (!element) return;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          child.textContent = ' ' + value + ' ';
          return;
        }
      }
    }
    label(card.querySelector('.card-header'), 'Medarbejderlogin');
    label(card.querySelector('label[for="login_user"]'), 'E-mailadresse');
    label(card.querySelector('a[href="/reset-password"]'), 'Glemt adgangskode?');
    label(card.querySelector('form button[type="submit"]'), 'Log ind');
    label(card.querySelector('#fido2-login'), 'Log ind med sikkerhedsnøgle');
    const userField = card.querySelector('#login_user');
    if (userField) userField.placeholder = 'E-mailadresse';
    const adminLink = card.parentElement.querySelector('p a[href="/admin"], p a[href="/domainadmin"]');
    const footer = adminLink && adminLink.closest('p');
    if (footer) {
      label(footer, 'Administration');
      label(footer.querySelector('a[href="/admin"]'), 'Administrator');
      label(footer.querySelector('a[href="/domainadmin"]'), 'Domæneadministrator');
    }
    for (const [selector, name] of [
      ['#dark-mode-toggle', 'Skift farvetema'],
      ['button[data-bs-toggle="dropdown"]', 'Vælg sprog'],
      ['button[aria-label="Toggle password visibility"]', 'Vis eller skjul adgangskode']
    ]) {
      const control = card.querySelector(selector);
      if (control) control.setAttribute('aria-label', name);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', presentLogin, { once: true });
  else presentLogin();
})();
