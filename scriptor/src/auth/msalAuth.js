// file: scriptor/src/auth/msalAuth.js
const msal = require('@azure/msal-node');
const { shell } = require('electron');
const http = require('http');
const crypto = require('crypto');
const log = require('electron-log');
const { getConfig, setConfig } = require('../main/config');

const SCOPES = ['User.Read', 'Calendars.Read', 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All', 'Presence.Read', 'Chat.ReadBasic'];
const REDIRECT_URI_BASE = 'http://localhost';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let msalApp = null;
let authInProgress = false;

function getMsalApp() {
  if (!msalApp) {
    const clientId = getConfig('azureClientId');
    const tenantId = getConfig('azureTenantId');

    if (!clientId || !tenantId) {
      throw new Error('Azure AD credentials not configured');
    }

    const msalConfig = {
      auth: {
        clientId,
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: REDIRECT_URI_BASE
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (cacheContext) => {
            try {
              const cachedData = getConfig('msalCache');
              if (cachedData) {
                cacheContext.tokenCache.deserialize(cachedData);
              }
            } catch (e) {
              log.warn('[MSAL] Cache deserialize failed, starting fresh', { error: e.message });
            }
          },
          afterCacheAccess: async (cacheContext) => {
            if (cacheContext.cacheHasChanged) {
              setConfig('msalCache', cacheContext.tokenCache.serialize());
            }
          }
        }
      },
      system: {
        loggerOptions: {
          loggerCallback: (level, message) => {
            log.debug('[MSAL]', message);
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Warning
        }
      }
    };

    msalApp = new msal.PublicClientApplication(msalConfig);
  }
  return msalApp;
}

function generatePkceCodes() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Start a temporary HTTP server on a random port to capture the OAuth redirect.
 * Binds to 127.0.0.1 only (loopback — no firewall prompt).
 * Returns { port, codePromise, cleanup }.
 */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    let timeoutHandle = null;
    let resolveCode, rejectCode;

    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try { server.close(); } catch (e) { /* already closed */ }
    }

    const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scriptor</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h3{color:#16a34a;margin:0 0 .5rem}p{color:#64748b;margin:0;font-size:14px}</style></head>
<body><div class="card"><h3>Sign-in successful!</h3><p>You can close this tab and return to Scriptor.</p></div></body></html>`;

    const ERROR_HTML = (msg) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scriptor</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h3{color:#dc2626;margin:0 0 .5rem}p{color:#64748b;margin:0;font-size:14px}</style></head>
<body><div class="card"><h3>Sign-in failed</h3><p>${msg}</p><p style="margin-top:.5rem">You can close this tab and try again in Scriptor.</p></div></body></html>`;

    server.on('request', (req, res) => {
      if (settled) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        return;
      }

      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (error) {
          settled = true;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML(errorDesc || error));
          rejectCode(new Error(errorDesc || error));
          cleanup();
          return;
        }

        if (code) {
          settled = true;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(SUCCESS_HTML);
          resolveCode(code);
          cleanup();
          return;
        }

        // Favicon or other request — ignore
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body></body></html>');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectCode(new Error('Local auth server error: ' + err.message));
      }
    });

    // Port 0 = OS assigns a random available port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log.info('[MSALAuth] Local auth server listening', { port });

      timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectCode(new Error('Microsoft login timed out. Please try again.'));
          cleanup();
        }
      }, AUTH_TIMEOUT_MS);

      resolve({ port, codePromise, cleanup });
    });
  });
}

async function initMsalAuth() {
  if (authInProgress) {
    return { success: false, error: 'Authentication already in progress. Please wait.' };
  }
  authInProgress = true;

  try {
    const app = getMsalApp();
    const { verifier, challenge } = generatePkceCodes();

    // Start temporary localhost server to capture the OAuth redirect
    const { port, codePromise, cleanup } = await startLocalServer();
    const redirectUri = REDIRECT_URI_BASE + ':' + port;

    const authCodeUrlParams = {
      scopes: SCOPES,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256'
    };

    const authUrl = await app.getAuthCodeUrl(authCodeUrlParams);
    log.info('[MSALAuth] Opening system browser for auth');

    // Open in system default browser
    await shell.openExternal(authUrl);

    let authCode;
    try {
      authCode = await codePromise;
    } catch (err) {
      cleanup();
      throw err;
    }

    // Exchange auth code for tokens — redirectUri must match exactly
    const tokenRequest = {
      code: authCode,
      scopes: SCOPES,
      redirectUri,
      codeVerifier: verifier
    };

    const authResult = await app.acquireTokenByCode(tokenRequest);

    if (authResult && authResult.account) {
      setConfig('microsoftUserId', authResult.account.localAccountId);
      setConfig('microsoftEmail', authResult.account.username);
      setConfig('userDisplayName', authResult.account.name || authResult.account.username);
      log.info('[MSALAuth] Interactive login successful', {
        email: authResult.account.username,
        displayName: authResult.account.name
      });
      return { success: true, account: authResult.account };
    }

    return { success: false, error: 'No account returned' };
  } catch (err) {
    log.error('[MSALAuth] Interactive login failed', { error: err.message });
    return { success: false, error: err.message };
  } finally {
    authInProgress = false;
  }
}

async function getAccessToken() {
  try {
    const app = getMsalApp();
    const accounts = await app.getTokenCache().getAllAccounts();

    if (accounts.length === 0) {
      log.warn('[MSALAuth] No cached accounts found');
      return null;
    }

    const silentRequest = {
      account: accounts[0],
      scopes: SCOPES
    };

    const result = await app.acquireTokenSilent(silentRequest);
    return result.accessToken;
  } catch (err) {
    log.error('[MSALAuth] Silent token acquisition failed', { error: err.message });
    return null;
  }
}

async function isAuthenticated() {
  try {
    const app = getMsalApp();
    const accounts = await app.getTokenCache().getAllAccounts();
    return accounts.length > 0;
  } catch (err) {
    log.error('[MSALAuth] Auth check failed', { error: err.message });
    return false;
  }
}

async function validateTokenOrReauth() {
  try {
    const token = await getAccessToken();
    if (token) return true;

    // Token refresh failed — need re-login
    log.warn('[MSALAuth] Token refresh failed, re-authentication required');
    return false;
  } catch (err) {
    log.error('[MSALAuth] Token validation failed', { error: err.message });
    return false;
  }
}

module.exports = { initMsalAuth, getAccessToken, isAuthenticated, validateTokenOrReauth };
