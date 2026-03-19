// file: scriptor/src/api/graphClientApp.js
// App-only Graph client using client credentials flow (no user context).
// Required for endpoints like getAllTranscripts that need application permissions.
const { Client } = require('@microsoft/microsoft-graph-client');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const log = require('electron-log');
const { getConfig } = require('../main/config');

let ccaApp = null;
let cachedToken = null;
let tokenExpiry = 0;

function getCCA() {
  if (!ccaApp) {
    const clientId = getConfig('azureClientId');
    const tenantId = getConfig('azureTenantId');
    const clientSecret = getConfig('azureClientSecret');

    if (!clientId || !tenantId || !clientSecret) {
      return null;
    }

    ccaApp = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret
      }
    });
  }
  return ccaApp;
}

async function getAppAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < tokenExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }

  const cca = getCCA();
  if (!cca) return null;

  try {
    const result = await cca.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default']
    });

    if (result && result.accessToken) {
      cachedToken = result.accessToken;
      tokenExpiry = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600 * 1000;
      return cachedToken;
    }
    return null;
  } catch (err) {
    log.error('[GraphClientApp] Failed to acquire app token', { error: err.message });
    return null;
  }
}

async function getAppGraphClient() {
  try {
    const accessToken = await getAppAccessToken();
    if (!accessToken) {
      log.debug('[GraphClientApp] No app token available (client secret may not be configured)');
      return null;
    }

    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });
  } catch (err) {
    log.error('[GraphClientApp] Failed to initialize app Graph client', { error: err.message });
    return null;
  }
}

module.exports = { getAppGraphClient };
