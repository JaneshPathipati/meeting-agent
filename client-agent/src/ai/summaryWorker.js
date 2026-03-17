// file: client-agent/src/ai/summaryWorker.js
// Local AI summary + tone analysis worker using Hugging Face models via @xenova/transformers.
// Spawned as a child process by localSummary.js.
// No cloud API required — models download on first use and run fully offline thereafter.
//
// Models used:
//   Summarization: Xenova/distilbart-cnn-6-6  (~360 MB, good for meeting content)
//   Tone alerts:   keyword + pattern matching (no model needed, instant)
//   Category:      keyword-based rule engine   (no model needed, instant)
//
// Usage: node summaryWorker.js <transcriptJsonPath> <cacheDir> <userName>
'use strict';

const fs   = require('fs');
const path = require('path');

function log(type, message) {
  process.stderr.write(JSON.stringify({ type, message }) + '\n');
}

// ── Category Detection (keyword-based, no model) ──────────────────────────────

const CATEGORY_RULES = [
  {
    id: 'client_conversation',
    keywords: [
      'client', 'customer', 'your requirement', 'your feedback', 'pain point',
      'deliverable', 'user story', 'satisfaction', 'support ticket', 'use case',
      'your team', 'your business', 'your workflow',
    ],
  },
  {
    id: 'consultant_meeting',
    keywords: [
      'sprint', 'standup', 'stand-up', 'retrospective', 'retro', 'blocker',
      'milestone', 'velocity', 'capacity', 'planning meeting', 'sync', 'check-in',
      'status update', 'release', 'scrum',
    ],
  },
  {
    id: 'target_company',
    keywords: [
      'target company', 'prospect', 'market analysis', 'competitive', 'competitor',
      'acquisition', 'due diligence', 'account planning', 'deal size', 'tam', 'sam',
      'market share', 'stakeholder map',
    ],
  },
  {
    id: 'sales_service',
    keywords: [
      'demo', 'pricing', 'proposal', 'objection', 'close the deal', 'contract',
      'onboarding', 'trial', 'renewal', 'upsell', 'budget', 'decision maker',
      'sign off', 'commercial',
    ],
  },
];

function detectCategory(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const rule of CATEGORY_RULES) {
    scores[rule.id] = rule.keywords.filter(kw => lower.includes(kw)).length;
  }
  const winner = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
  return winner[1] > 0 ? winner[0] : 'general';
}

// ── Participants ──────────────────────────────────────────────────────────────

function extractParticipants(segments) {
  const seen = new Set();
  for (const seg of segments) {
    if (seg.speaker && seg.speaker.trim()) seen.add(seg.speaker.trim());
  }
  return [...seen];
}

// ── Action Item Extraction (regex) ───────────────────────────────────────────

const ACTION_PATTERNS = [
  /(?:will|going to|need to|should|must|has to)\s+([^.!?\n]{10,150}[.!?])/gi,
  /action item[:\s]+([^.!?\n]{10,150}[.!?])/gi,
  /follow[- ]?up[:\s]+([^.!?\n]{10,150}[.!?])/gi,
  /next step[:\s]+([^.!?\n]{10,150}[.!?])/gi,
  /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+(?:will|needs to|should)\s+[^.!?\n]{10,150}[.!?])/g,
];

function extractActionItems(text, participants) {
  const seen = new Set();
  const items = [];

  for (const pattern of ACTION_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const task = match[1].trim().replace(/\s+/g, ' ');
      if (task.length < 10 || seen.has(task.toLowerCase())) continue;
      seen.add(task.toLowerCase());

      let owner = 'TBD';
      for (const p of participants) {
        const firstName = p.split(' ')[0];
        if (firstName.length > 2 && task.toLowerCase().includes(firstName.toLowerCase())) {
          owner = p;
          break;
        }
      }

      items.push({ owner, task, deadline: 'TBD' });
      if (items.length >= 6) break;
    }
    if (items.length >= 6) break;
  }
  return items;
}

// ── Decision Extraction (regex) ───────────────────────────────────────────────

const DECISION_PATTERNS = [
  /(?:we decided|team decided|it was decided|agreed to|resolved to|conclusion[:\s]+)\s*([^.!?\n]{10,200}[.!?])/gi,
  /(?:decision[:\s]+)\s*([^.!?\n]{10,200}[.!?])/gi,
  /(?:we will go with|going forward(?:\s+with)?)[:\s]+([^.!?\n]{10,200}[.!?])/gi,
];

function extractDecisions(text) {
  const seen = new Set();
  const decisions = [];

  for (const pattern of DECISION_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const decision = match[1].trim().replace(/\s+/g, ' ');
      if (decision.length < 10 || seen.has(decision.toLowerCase())) continue;
      seen.add(decision.toLowerCase());
      decisions.push({ decision, context: '' });
      if (decisions.length >= 4) break;
    }
    if (decisions.length >= 4) break;
  }
  return decisions;
}

// ── Open Questions Extraction ─────────────────────────────────────────────────

function extractOpenQuestions(segments) {
  const questions = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const sentences = seg.text.split(/[.!]/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      if (s.endsWith('?') && s.length > 15 && questions.length < 4) {
        questions.push(s);
      }
    }
  }
  return questions;
}

// ── Tone Alert Detection (keyword/pattern, no model) ─────────────────────────
// Models the same categories as the original OpenAI-based tone analysis.

const TONE_RULES = [
  {
    pattern: /\b(stupid|idiot|incompetent|useless|moron|how dare you|shut up|you['']?re wrong|get out)\b/i,
    severity: 'high',
    reason: 'Aggressive or hostile language',
  },
  {
    pattern: /\b(discriminat|sexist|racist|ageist|prejudice|you people|those people|typical\s+\w+)\b/i,
    severity: 'high',
    reason: 'Potentially discriminatory language',
  },
  {
    pattern: /\b(obviously|clearly you don['']?t|as i['']?ve told you|how many times|basic(ally)?|you never|you always)\b/i,
    severity: 'medium',
    reason: 'Condescending or patronizing tone',
  },
  {
    pattern: /\b(that['']?s not relevant|i don['']?t care|move on|not my problem|why are you even|irrelevant)\b/i,
    severity: 'medium',
    reason: 'Dismissive behavior',
  },
  {
    pattern: /\b(passive.?aggress|yeah right|sure\s+sure|good luck with that|interesting idea\.{3})\b/i,
    severity: 'medium',
    reason: 'Passive-aggressive remarks',
  },
  {
    pattern: /\b(profan|\bf[*u][*c][*k]\b|damn it|what the hell|this is bullsh)\b/i,
    severity: 'medium',
    reason: 'Unprofessional language',
  },
  {
    pattern: /\b(ridiculous|seriously\?|are you kidding|unbelievable|i can['']?t believe|this is absurd)\b/i,
    severity: 'low',
    reason: 'Frustrated or impatient outburst',
  },
  {
    pattern: /\b(sarcasm|yeah yeah|whatever|sure thing|brilliant idea|genius move)\b/i,
    severity: 'low',
    reason: 'Sarcastic or mocking tone',
  },
];

function detectToneAlerts(segments) {
  const alerts = [];
  for (const seg of segments) {
    if (!seg.text || seg.text.length < 5) continue;
    for (const { pattern, severity, reason } of TONE_RULES) {
      if (pattern.test(seg.text)) {
        alerts.push({
          start_time:   seg.start_time || '00:00:00',
          speaker:      seg.speaker    || 'Unknown',
          severity,
          flagged_text: seg.text.length > 200 ? seg.text.substring(0, 200) + '...' : seg.text,
          reason,
        });
        break; // One alert per segment maximum
      }
    }
  }
  return alerts;
}

// ── Structured JSON Builder ───────────────────────────────────────────────────

function buildStructuredJson(summaryText, participants, segments, category) {
  const sentences = summaryText.split(/(?<=[.!?])\s+/);
  const executiveSummary = sentences.slice(0, 3).join(' ');
  const keyPoints = sentences.filter(s => s.length > 30).slice(0, 6);

  const fullText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const actionItems = extractActionItems(summaryText + '\n' + fullText, participants);
  const decisions   = extractDecisions(summaryText + '\n' + fullText);
  const openQs      = extractOpenQuestions(segments);

  return {
    executive_summary:    executiveSummary,
    participants,
    key_discussion_points: keyPoints,
    decisions_made:        decisions,
    action_items:          actionItems,
    open_questions:        openQs,
  };
}

// ── Markdown Summary Builder ──────────────────────────────────────────────────

function buildMarkdownSummary(summaryText, structuredJson, category) {
  const { participants, decisions_made, action_items } = structuredJson;

  const categoryLabel = category.replace(/_/g, ' ');
  const participantStr = participants.join(', ') || 'Not identified';

  const decisionLines = decisions_made.length > 0
    ? decisions_made.map((d, i) => `${i + 1}. ${d.decision}`).join('\n')
    : 'No formal decisions were recorded.';

  const actionLines = action_items.length > 0
    ? ['| Owner | Task | Deadline |', '|-------|------|----------|',
       ...action_items.map(a => `| ${a.owner} | ${a.task} | ${a.deadline} |`)].join('\n')
    : 'No action items were assigned.';

  const keyPoints = structuredJson.key_discussion_points;
  const keyPointLines = keyPoints.length > 0
    ? keyPoints.map(p => `- ${p}`).join('\n')
    : `- ${summaryText.substring(0, 200)}`;

  return [
    '## Meeting Overview',
    `**Type:** ${categoryLabel}`,
    `**Participants:** ${participantStr}`,
    '',
    '## Summary',
    summaryText,
    '',
    '## Key Discussion Points',
    keyPointLines,
    '',
    '## Decisions Made',
    decisionLines,
    '',
    '## Action Items',
    actionLines,
    '',
    '## Follow-Up Questions',
    structuredJson.open_questions.length > 0
      ? structuredJson.open_questions.map(q => `- ${q}`).join('\n')
      : '- Review action items and confirm owners at next meeting.',
  ].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [transcriptPath, cacheDir, userName] = process.argv.slice(2);

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const transcriptJson = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const segments = transcriptJson.segments || [];

  if (segments.length === 0) {
    log('warn', 'Transcript has no segments — returning empty AI result');
    process.stdout.write(JSON.stringify({
      type:          'result',
      category:      'general',
      summary:       '',
      structuredJson: null,
      toneAlerts:    [],
    }) + '\n');
    return;
  }

  const plainText      = segments.map(s => s.text || '').join(' ');
  const transcriptText = segments.map(s => `[${s.start_time}] ${s.speaker}: ${s.text}`).join('\n');

  // Fast, no-model steps
  const category     = detectCategory(plainText);
  const participants = extractParticipants(segments);
  const toneAlerts   = detectToneAlerts(segments);

  log('info', `Category: ${category}, Participants: ${participants.join(', ')}, Tone alerts: ${toneAlerts.length}`);

  // ── Summarization via Hugging Face (Xenova/distilbart-cnn-6-6) ──
  log('info', 'Loading summarization model (Xenova/distilbart-cnn-6-6, ~360 MB)...');
  log('info', 'First run will download the model; subsequent runs use local cache.');

  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = cacheDir || path.join(
    process.env.USERPROFILE || process.env.HOME || '.',
    '.cache', 'meetchamp-hf'
  );
  env.allowRemoteModels = true;
  env.allowLocalModels  = true;

  const summarizer = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6', {
    quantized: true,
  });
  log('info', 'Summarization model loaded.');

  // BART max input ~1024 tokens ≈ ~750 words. Split long transcripts into chunks.
  const CHUNK_WORDS = 650;
  const words  = plainText.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS) {
    chunks.push(words.slice(i, i + CHUNK_WORDS).join(' '));
  }

  const summaryParts = [];
  for (const chunk of chunks.slice(0, 4)) { // Cap at 4 chunks (~2600 words) for speed
    try {
      const result = await summarizer(chunk, {
        max_new_tokens: 180,
        min_new_tokens: 40,
        no_repeat_ngram_size: 3,
      });
      if (result[0]?.summary_text?.trim()) {
        summaryParts.push(result[0].summary_text.trim());
      }
    } catch (chunkErr) {
      log('warn', `Chunk summarization failed: ${chunkErr.message}`);
    }
  }

  // Fallback: if model failed on all chunks, use first 500 chars of transcript
  const summaryText = summaryParts.length > 0
    ? summaryParts.join(' ')
    : plainText.substring(0, 500) + (plainText.length > 500 ? '...' : '');

  const structuredJson = buildStructuredJson(summaryText, participants, segments, category);
  const markdownSummary = buildMarkdownSummary(summaryText, structuredJson, category);

  process.stdout.write(JSON.stringify({
    type:          'result',
    category,
    summary:       markdownSummary,
    structuredJson,
    toneAlerts,
  }) + '\n');
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
  process.exit(1);
});
