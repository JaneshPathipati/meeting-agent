// file: client-agent/src/api/graphClient.js
const { Client } = require('@microsoft/microsoft-graph-client');
const log = require('electron-log');
const { getAccessToken } = require('../auth/msalAuth');

let graphClient = null;

async function getGraphClient() {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      log.warn('[GraphClient] No access token available');
      return null;
    }

    graphClient = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });

    return graphClient;
  } catch (err) {
    log.error('[GraphClient] Failed to initialize Graph client', { error: err.message });
    return null;
  }
}

module.exports = { getGraphClient };
