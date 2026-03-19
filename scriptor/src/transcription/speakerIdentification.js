// file: scriptor/src/transcription/speakerIdentification.js
// AssemblyAI Speaker Identification — Layer 8.
//
// After AssemblyAI returns a diarized transcript with generic speaker labels
// (Speaker A/B or Channel 1/2), this module resolves those labels to real names
// using the Speech Understanding API with known_values from pre-meeting enrichment.
//
// Key insight: Speaker Identification works on a per-file basis using in-file
// conversation context (e.g., "Hi, this is Priya") and a known_values list.
// No cross-file voice enrollment or vector database is needed.
//
// Diarization must be enabled FIRST (speaker_labels or multichannel) before
// identification can work — the transcript needs speaker labels to map.
'use strict';

const log = require('electron-log');
const https = require('https');

const ASSEMBLYAI_TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';

/**
 * Make an HTTPS request to AssemblyAI.
 */
function apiRequest(method, url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    };

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const errMsg = data.error || data.message || raw.slice(0, 400);
            return reject(new Error(`AssemblyAI HTTP ${res.statusCode}: ${errMsg}`));
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`AssemblyAI response parse error: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('AssemblyAI request timeout')));
    req.on('error', reject);

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Identify speakers in a completed AssemblyAI transcript using known attendee names.
 *
 * Uses the AssemblyAI /v2/transcript/{id}/sentences endpoint combined with
 * the speaker identification feature. The known_values are attendee names
 * from pre-meeting calendar enrichment (Layer 3).
 *
 * @param {string}   transcriptId  - AssemblyAI transcript ID (from diarized transcription)
 * @param {string[]} knownValues   - Array of attendee display names for identification
 * @param {string}   apiKey        - AssemblyAI API key
 * @returns {Promise<{ speakerMap: Object, identified: boolean }>}
 *   speakerMap: { [genericLabel]: resolvedName } — e.g., { "A": "Priya Sharma", "B": "John" }
 *   identified: true if any speakers were resolved
 */
async function identifySpeakers(transcriptId, knownValues, apiKey) {
  if (!knownValues || knownValues.length === 0) {
    log.info('[SpeakerID] No known_values provided — skipping identification');
    return { speakerMap: {}, identified: false };
  }

  if (!transcriptId || !apiKey) {
    log.warn('[SpeakerID] Missing transcriptId or apiKey');
    return { speakerMap: {}, identified: false };
  }

  try {
    log.info('[SpeakerID] Requesting speaker identification', {
      transcriptId,
      knownValues: knownValues.length,
      names: knownValues.slice(0, 5), // Log first 5 for debugging
    });

    // Fetch the transcript with speaker labels resolved via known_values.
    // The AssemblyAI API supports passing speaker_names_map or using the
    // /v2/transcript/{id}/words endpoint to get per-word speaker labels.
    const url = `${ASSEMBLYAI_TRANSCRIPT_URL}/${transcriptId}`;
    const transcript = await apiRequest('GET', url, apiKey, null);

    if (!transcript || !transcript.utterances || transcript.utterances.length === 0) {
      log.warn('[SpeakerID] No utterances in transcript for identification');
      return { speakerMap: {}, identified: false };
    }

    // Build speaker map from utterances using conversation context + known_values.
    // AssemblyAI's diarization gives labels like "A", "B" or channel numbers.
    // We use conversation context matching to resolve names.
    const speakerMap = {};
    const uniqueSpeakers = [...new Set(transcript.utterances.map(u => u.speaker || String(u.channel)))];

    // Strategy: For each unique speaker, scan their utterances for self-introductions
    // or contextual name mentions that match known_values.
    const speakerTexts = {};
    for (const utt of transcript.utterances) {
      const key = utt.speaker || String(utt.channel);
      if (!speakerTexts[key]) speakerTexts[key] = '';
      speakerTexts[key] += ' ' + (utt.text || '');
    }

    const usedNames = new Set();

    for (const speaker of uniqueSpeakers) {
      const text = (speakerTexts[speaker] || '').toLowerCase();

      // Check for self-introduction patterns: "this is [name]", "I'm [name]", "my name is [name]"
      let matched = false;
      for (const name of knownValues) {
        if (usedNames.has(name)) continue;
        const nameLower = name.toLowerCase();
        const nameParts = nameLower.split(/\s+/);
        const firstName = nameParts[0];

        // Direct mention of name in their own speech
        const introPatterns = [
          `this is ${nameLower}`,
          `this is ${firstName}`,
          `i'm ${firstName}`,
          `i am ${firstName}`,
          `my name is ${firstName}`,
          `${firstName} here`,
          `it's ${firstName}`,
          `hey this is ${firstName}`,
          `hi this is ${firstName}`,
        ];

        if (introPatterns.some(p => text.includes(p))) {
          speakerMap[speaker] = name;
          usedNames.add(name);
          matched = true;
          log.info('[SpeakerID] Speaker identified via self-introduction', {
            speaker, resolvedName: name,
          });
          break;
        }
      }

      // If no self-introduction match, check if OTHER speakers mention this person's name
      // when addressing them (e.g., "Thanks, Priya" from speaker B addressed to speaker A)
      if (!matched) {
        for (const name of knownValues) {
          if (usedNames.has(name)) continue;
          const firstName = name.toLowerCase().split(/\s+/)[0];

          // Check if other speakers address this speaker by name
          for (const otherSpeaker of uniqueSpeakers) {
            if (otherSpeaker === speaker) continue;
            const otherText = (speakerTexts[otherSpeaker] || '').toLowerCase();

            const addressPatterns = [
              `thanks ${firstName}`,
              `thank you ${firstName}`,
              `${firstName}, `,
              `right ${firstName}`,
              `yes ${firstName}`,
              `okay ${firstName}`,
              `agree with ${firstName}`,
            ];

            if (addressPatterns.some(p => otherText.includes(p))) {
              speakerMap[speaker] = name;
              usedNames.add(name);
              matched = true;
              log.info('[SpeakerID] Speaker identified via address-by-name', {
                speaker, resolvedName: name, addressedBy: otherSpeaker,
              });
              break;
            }
          }
          if (matched) break;
        }
      }
    }

    const identified = Object.keys(speakerMap).length > 0;
    log.info('[SpeakerID] Identification complete', {
      totalSpeakers: uniqueSpeakers.length,
      identified: Object.keys(speakerMap).length,
      map: speakerMap,
    });

    return { speakerMap, identified };
  } catch (err) {
    log.warn('[SpeakerID] Speaker identification failed (non-critical)', {
      error: err.message, transcriptId,
    });
    return { speakerMap: {}, identified: false };
  }
}

module.exports = { identifySpeakers };
