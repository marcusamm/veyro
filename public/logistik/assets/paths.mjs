// Generated pages explicitly choose the account adapter. Public preview pages
// keep the external handoff; only the account/domain builds opt into same-origin.
export const basePath = typeof document === 'undefined' ? '' : (document.body.dataset.basePath || '');
export const sitePath = path => `${basePath}${path}`;
export const accountOrigin = typeof document !== 'undefined' && document.body.dataset.accountOrigin === '' ? '' : 'https://kunde.veyro.dk';
export const accountPath = path => `${accountOrigin}/logistik${path}`;
