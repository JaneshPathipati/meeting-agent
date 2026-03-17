// file: client-agent/src/ai/localSummary.js
// Orchestrates AI summary + tone generation.
// Tries OpenAI GPT first (fast, high quality), falls back to local Hugging Face models.
// Returns { category, summary, structuredJson, toneAlerts }
'use strict';

const { execFile } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const log   = require('electron-log');

// ── OpenAI GPT Summary ──────────────────────────────────────────────────────

function getOpenAIKey() {
  try {
    const defaults = require('../main/defaults.js');
    if (defaults.OPENAI_API_KEY) return defaults.OPENAI_API_KEY;
  } catch (_) {}
  return process.env.OPENAI_API_KEY || '';
}

function formatTranscript(transcript) {
  if (!transcript.segments || transcript.segments.length === 0) return '';
  return transcript.segments
    .map(s => `[${s.start_time}] ${s.speaker}: ${s.text}`)
    .join('\n');
}

function callOpenAISummary(transcript, userName) {
  return new Promise((resolve, reject) => {
    const apiKey = getOpenAIKey();
    if (!apiKey) return reject(new Error('OPENAI_API_KEY not set'));

    const transcriptText = formatTranscript(transcript);
    if (!transcriptText) return reject(new Error('Empty transcript'));

    const systemPrompt =
      `You are a meeting assistant. Analyze the transcript and return a JSON object with exactly these fields:\n` +
      `- category: one of "client_conversation","internal_meeting","consultant_meeting","interview","sales_call","general"\n` +
      `- summary: REQUIRED — 2-4 sentences summarizing what was discussed. Never leave this empty. If the meeting was short or unclear, describe what you can infer from the content.\n` +
      `- structuredJson: { participants: string[], keyTopics: string[], actionItems: string[], decisions: string[] }\n` +
      `- toneAlerts: array of { speaker, issue, severity } for aggressive/unprofessional tone, empty array if none\n` +
      `Respond ONLY with valid JSON. The summary field must always contain a non-empty string.`;

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Transcript:\n${transcriptText}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode !== 200) {
            return reject(new Error(`OpenAI ${res.statusCode}: ${parsed.error?.message || raw.slice(0, 200)}`));
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('Empty OpenAI response'));
          resolve(JSON.parse(content));
        } catch (e) {
          reject(new Error(`OpenAI parse failed: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(60000, () => {
      req.destroy(new Error('OpenAI summary request timed out after 60s'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getWorkerPath() {
  const { app } = require('electron');
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath, 'app.asar.unpacked',
      'src', 'ai', 'summaryWorker.js'
    );
  }
  return path.join(__dirname, 'summaryWorker.js');
}

function getHfCacheDir() {
  const { app } = require('electron');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hf-cache');
  }
  return path.join(__dirname, '..', '..', 'hf-cache');
}

function getNodeExe() {
  const { app } = require('electron');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node-runtime', 'node.exe');
  }
  return process.execPath.includes('electron') ? 'node' : process.execPath;
}

/**
 * Generate meeting summary, category, structured JSON, and tone alerts
 * using local Hugging Face models. No cloud API required.
 *
 * @param {object} transcript  - Transcript JSON from transcribeAudio()
 * @param {string} userName    - Employee's display name
 * @param {string} meetingId   - Meeting ID (used to name temp file)
 * @returns {Promise<{category, summary, structuredJson, toneAlerts}>}
 */
async function generateLocalAI(transcript, userName, meetingId) {
  // ── Try OpenAI GPT first (fast: ~2s vs 84s local) ──
  try {
    const result = await callOpenAISummary(transcript, userName);

    // If GPT returned empty summary, build one from structuredJson as fallback
    let summary = result.summary || '';
    if (!summary.trim() && result.structuredJson) {
      const sj = result.structuredJson;
      const topics = (sj.keyTopics || []).slice(0, 3).join(', ');
      const participants = (sj.participants || []).join(' and ') || userName;
      if (topics) {
        summary = `${participants} had a ${result.category || 'general'} meeting covering: ${topics}.`;
        if ((sj.actionItems || []).length > 0) {
          summary += ` Action items: ${sj.actionItems.slice(0, 2).join('; ')}.`;
        }
      }
    }

    log.info('[LocalAI] OpenAI summary succeeded', {
      category:  result.category,
      summaryLen: summary.length,
      toneAlerts: result.toneAlerts?.length || 0,
    });
    return {
      category:      result.category      || 'general',
      summary:       summary,
      structuredJson: result.structuredJson || null,
      toneAlerts:    result.toneAlerts    || [],
    };
  } catch (err) {
    log.warn('[LocalAI] OpenAI summary failed, falling back to local model', { error: err.message });
  }

  // ── Fallback: local Hugging Face model ──
  const tmpFile = path.join(
    os.tmpdir(),
    `meetchamp_tx_${meetingId || Date.now()}.json`
  );

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(transcript));

    return await new Promise((resolve, reject) => {
      const nodeExe    = getNodeExe();
      const workerPath = getWorkerPath();
      const cacheDir   = getHfCacheDir();

      if (!fs.existsSync(cacheDir)) {
        try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }
      }

      const args = [workerPath, tmpFile, cacheDir, userName || 'You'];

      log.info('[LocalAI] Spawning summary worker', {
        segments: transcript.segments?.length || 0,
        userName,
      });

      execFile(nodeExe, args, {
        timeout: 25 * 60 * 1000, // 25 min — first run includes model download (~360 MB)
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        // Forward structured log lines from worker
        if (stderr) {
          for (const line of stderr.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.type === 'info')  log.info('[LocalAI]', msg.message);
              if (msg.type === 'warn')  log.warn('[LocalAI]', msg.message);
              if (msg.type === 'error') log.error('[LocalAI]', msg.message);
            } catch {
              log.debug('[LocalAI] worker:', trimmed);
            }
          }
        }

        if (error) {
          log.error('[LocalAI] Worker failed', { error: error.message });
          // Return a minimal fallback so the meeting still uploads
          return resolve({
            category:      'general',
            summary:       '',
            structuredJson: null,
            toneAlerts:    [],
          });
        }

        try {
          const lines = stdout.trim().split('\n').filter(Boolean);
          const msg   = JSON.parse(lines[lines.length - 1]);

          if (msg.type === 'result') {
            log.info('[LocalAI] AI generation complete', {
              category:    msg.category,
              summaryLen:  msg.summary?.length || 0,
              toneAlerts:  msg.toneAlerts?.length || 0,
            });
            return resolve({
              category:      msg.category      || 'general',
              summary:       msg.summary       || '',
              structuredJson: msg.structuredJson || null,
              toneAlerts:    msg.toneAlerts    || [],
            });
          }
          // Unexpected output — still resolve so meeting uploads
          log.warn('[LocalAI] Unexpected worker output', { stdout: stdout.substring(0, 300) });
          resolve({ category: 'general', summary: '', structuredJson: null, toneAlerts: [] });
        } catch (parseErr) {
          log.error('[LocalAI] Failed to parse worker output', { parseErr: parseErr.message });
          resolve({ category: 'general', summary: '', structuredJson: null, toneAlerts: [] });
        }
      });
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

module.exports = { generateLocalAI };
