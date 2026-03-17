// file: client-agent/src/api/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');
const log = require('electron-log');
const { getConfig } = require('../main/config');

let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseClient) {
    const url = getConfig('supabaseUrl');
    const serviceRoleKey = getConfig('supabaseServiceRoleKey');

    if (!url || !serviceRoleKey) {
      throw new Error('Supabase credentials not configured');
    }

    supabaseClient = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      global: {
        headers: {
          'x-agent-version': '1.0.0'
        },
        fetch: (url, options = {}) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
        }
      }
    });

    log.info('[SupabaseClient] Client initialized');
  }
  return supabaseClient;
}

async function testConnection() {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('organizations')
      .select('id')
      .limit(1);

    if (error) {
      log.error('[SupabaseClient] Connection test failed', { error: error.message });
      return false;
    }

    log.info('[SupabaseClient] Connection test successful');
    return true;
  } catch (err) {
    log.error('[SupabaseClient] Connection test error', { error: err.message });
    return false;
  }
}

module.exports = { getSupabaseClient, testConnection };
