export const legacyAjHost = 'aj.veyro.dk';
export const primaryAjHost = 'aj-auto-slagelse.dk';
export const wwwAjHost = 'www.' + primaryAjHost;
export const legacyAjOrigin = 'https://' + legacyAjHost;
export const primaryAjOrigin = 'https://' + primaryAjHost;

// Serve existing booking and login links on their original host during the move.
export function publicAjOrigin(hostname: string): string | undefined {
  if (hostname === primaryAjHost || hostname === wwwAjHost) return primaryAjOrigin;
  if (hostname === legacyAjHost) return legacyAjOrigin;
  return undefined;
}
