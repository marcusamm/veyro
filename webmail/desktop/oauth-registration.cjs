'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {normalizeConfig} = require('./oauth.cjs');

// Registered desktop client credentials are supplied explicitly for a local
// run or as a separate resource by build:configured. They never live in Git.
function loadOAuthRegistration({isPackaged, resourcesPath, explicitFile, template = {}}) {
  const filename = isPackaged ? path.join(resourcesPath, 'oauth-config.runtime.json') : explicitFile;
  if (!filename) return normalizeConfig(template);
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return normalizeConfig(data);
  } catch (error) {
    if (isPackaged && error.code === 'ENOENT') return normalizeConfig(template);
    throw new Error('OAuth-konfigurationen kunne ikke læses. Kontrollér den lokale registreringsfil.');
  }
}
module.exports = {loadOAuthRegistration};
