(() => {
  'use strict';
  const switcher = document.querySelector('[data-language-switch]');
  if (!switcher) return;
  const updateLinks = () => {
    switcher.querySelectorAll('[data-language-link]').forEach(link => {
      const url = new URL(link.getAttribute('href'), location.origin);
      url.search = location.search;
      url.searchParams.delete('kontakt');
      url.searchParams.delete('form');
      url.searchParams.set('lang', link.lang);
      const service = document.querySelector('select[name="contact[Ydelse]"]');
      const tier = document.querySelector('[data-webshop-enquiry-select]');
      if (service?.value) {
        const key = service.selectedOptions[0]?.dataset.key;
        if (key) url.searchParams.set('ydelse', key);
        if (service.value === 'Pakke: Webshop' && tier) url.searchParams.set('webshop_niveau', tier.value);
        else url.searchParams.delete('webshop_niveau');
      } else if (service && service.dataset.userChanged === 'true') {
        url.searchParams.delete('ydelse');
        url.searchParams.delete('webshop_niveau');
      }
      url.hash = location.hash;
      link.href = url.pathname + url.search + url.hash;
    });
  };
  updateLinks();
  window.addEventListener('hashchange', updateLinks);
  document.addEventListener('change', event => {
    if (event.target.matches('select[name="contact[Ydelse]"], [data-webshop-enquiry-select]')) {
      event.target.dataset.userChanged = 'true';
      updateLinks();
    }
  });
  document.addEventListener('click', event => {
    if (!switcher.contains(event.target)) switcher.open = false;
  });
  switcher.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    switcher.open = false;
    switcher.querySelector('summary').focus();
  });
})();
