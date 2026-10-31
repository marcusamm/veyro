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
      url.hash = location.hash;
      link.href = url.pathname + url.search + url.hash;
    });
  };
  updateLinks();
  window.addEventListener('hashchange', updateLinks);
  document.addEventListener('click', event => {
    if (!switcher.contains(event.target)) switcher.open = false;
  });
  switcher.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    switcher.open = false;
    switcher.querySelector('summary').focus();
  });
})();
