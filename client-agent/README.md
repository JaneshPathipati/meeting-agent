# MeetChamp - Client Agent

Silent Electron desktop agent for Windows 10/11 (x64).

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. Download Parakeet ONNX model files into `models/`:
   - `encoder.onnx` (622MB)
   - `decoder.onnx` (6.9MB)
   - `joiner.onnx` (1.7MB)
   - `tokens.txt`
3. Place `ffmpeg.exe` and `audiocapturer.exe` in `bin/`
4. Run `npm install`
5. Run `npm run rebuild` (rebuilds native modules for Electron)
6. Run `npm run dev` to start in development mode

## Build Installer

```bash
npm run build
```

Output: `release/MeetChamp Setup.exe`

## Architecture

- **Main process:** Meeting detection, audio capture, transcription, upload
- **Preload:** Secure context bridge for renderer IPC
- **Renderer:** One-time Microsoft login window only
- **No user-facing UI** after initial login
