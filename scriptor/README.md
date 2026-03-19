# Scriptor - Client Agent v2.0

Silent Electron desktop agent for Windows 10/11 (x64).
Detects, records, transcribes, and summarizes meetings automatically.

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. Place `ffmpeg.exe` in `bin/`
3. Run `npm install`
4. Run `npm run rebuild` (rebuilds native modules for Electron)
5. Run `npm run dev` to start in development mode

## Build Installer

```bash
npm run build
```

Output: `release/Scriptor Setup.exe` (NSIS installer)

## Architecture

### Pipeline Flow

```
Detection IDLE -> CANDIDATE
  |-- Layer 3: enrichCandidate() fires (calendar attendees -> known_values[])

CANDIDATE -> RECORDING (after debounce)
  |-- Electron desktopCapturer (WASAPI loopback) + ffmpeg mic capture

RECORDING -> STOPPING -> processMeeting()
  |-- Layer 5:  Teams -> try VTT first (free), fallback to AssemblyAI
  |             Google Meet / others -> always AssemblyAI
  |-- Layer 6:  AssemblyAI (SLAM model, multichannel stereo / speaker_labels mono)
  |-- Layer 8:  Speaker Identification via known_values from enrichment
  |-- Layer 9:  AI Summary (OpenAI GPT -> local HuggingFace fallback)
  |-- Layer 10: Upload to Supabase + deferred Teams transcript polling
```

### Source Layout

```
src/
  main/           Electron main process (app lifecycle, config, tray, watchdog)
  detection/      Meeting detection state machine + Teams Presence API
  enrichment/     Pre-meeting calendar enrichment (Layer 3)
  audio/          Mic recording (ffmpeg) + system audio (Electron WASAPI loopback)
  transcription/  AssemblyAI transcription + Speaker ID + Teams VTT
  pipeline/       Post-meeting pipeline orchestrator
  ai/             AI summary (OpenAI GPT / local HuggingFace)
  api/            Supabase client, Graph API clients, upload + retry queue
  auth/           MSAL OAuth for Microsoft Graph
  database/       SQLite upload retry queue
  renderer/       Setup wizard UI + system capture hidden window
```

### Key Dependencies

- **Electron 28** - Desktop framework with WASAPI loopback support
- **AssemblyAI** - Transcription + speaker diarization (SLAM model)
- **OpenAI GPT-4o** - Meeting summary generation
- **MS Graph API** - Teams calendar, presence, VTT transcripts
- **Supabase** - Backend storage + RLS
- **ffmpeg** - Audio processing (mic capture, WAV conversion, stereo merge)

### Supported Platforms

Desktop: Teams, Zoom, Webex, Slack
Web: Teams, Google Meet, Zoom, Webex, GoTo Meeting, Slack Huddle
Browsers: Chrome, Edge, Brave, Firefox, Opera, Vivaldi, Arc
