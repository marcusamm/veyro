// The same static source runs at the preview root and under Veyro's account host.
export const basePath = typeof document === 'undefined' ? '' : (document.body.dataset.basePath || '');
export const sitePath = path => `${basePath}${path}`;
export const accountOrigin = typeof location !== 'undefined' && basePath === '/logistik' ? '' : 'https://kunde.veyro.dk';
export const accountPath = path => `${accountOrigin}/logistik${path}`;
