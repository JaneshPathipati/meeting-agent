// file: client-agent/src/renderer/systemCapture.js
// Captures system audio via getDisplayMedia (Electron 26+ with setDisplayMediaRequestHandler).
// All console.log/error messages are forwarded to the main process log via webContents console-message.
'use strict';

let mediaRecorder = null;
let chunks        = [];
let outputPath    = null;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

window.captureAPI.onStart(async (path, sourceId) => {
  outputPath = path;
  chunks     = [];

  console.log('[SystemCapture] Start requested', { path, sourceId });

  let stream = null;

  // ── Path A: getDisplayMedia (Electron 26+ with setDisplayMediaRequestHandler) ──
  // The main process handler responds with audio: 'loopback' automatically
  try {
    console.log('[SystemCapture] Trying getDisplayMedia...');
    stream = await withTimeout(
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      10000,
      'getDisplayMedia'
    );
    console.log('[SystemCapture] getDisplayMedia succeeded');
  } catch (e1) {
    console.warn('[SystemCapture] getDisplayMedia failed: ' + e1.message);
  }

  // ── Path B: getUserMedia with chromeMediaSource (legacy fallback) ──
  if (!stream && sourceId) {
    try {
      console.log('[SystemCapture] Trying getUserMedia with sourceId: ' + sourceId);
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1,
              maxHeight: 1,
              maxFrameRate: 1,
            },
          },
        }),
        10000,
        'getUserMedia'
      );
      console.log('[SystemCapture] getUserMedia succeeded');
    } catch (e2) {
      console.error('[SystemCapture] getUserMedia also failed: ' + e2.message);
    }
  }

  if (!stream) {
    console.error('[SystemCapture] All capture methods failed');
    window.captureAPI.captureError('All capture methods failed (getDisplayMedia + getUserMedia)');
    return;
  }

  try {
    // Drop video tracks — we only need audio
    const videoTracks = stream.getVideoTracks();
    console.log('[SystemCapture] Dropping ' + videoTracks.length + ' video tracks');
    videoTracks.forEach(t => t.stop());

    const audioTracks = stream.getAudioTracks();
    console.log('[SystemCapture] Audio tracks: ' + audioTracks.length);

    if (audioTracks.length === 0) {
      window.captureAPI.captureError('No audio tracks in capture stream');
      return;
    }

    // Log audio track settings
    const settings = audioTracks[0].getSettings();
    console.log('[SystemCapture] Audio track settings: ' + JSON.stringify(settings));

    const audioStream = new MediaStream(audioTracks);
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';

    console.log('[SystemCapture] Creating MediaRecorder with mimeType: ' + (mimeType || 'default'));
    mediaRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      console.log('[SystemCapture] MediaRecorder stopped, chunks: ' + chunks.length);
      try {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        console.log('[SystemCapture] Blob size: ' + blob.size);

        const arrayBuffer = await withTimeout(blob.arrayBuffer(), 8000, 'blob.arrayBuffer');
        const webmPath = outputPath + '.webm';
        window.captureAPI.writeFile(webmPath, arrayBuffer);
        console.log('[SystemCapture] WebM written: ' + webmPath + ' (' + arrayBuffer.byteLength + ' bytes)');
        window.captureAPI.captureStopped(webmPath);
      } catch (err) {
        console.error('[SystemCapture] Failed to write audio: ' + err.message);
        window.captureAPI.captureError('Failed to write audio: ' + err.message);
      }
    };

    mediaRecorder.onerror = (e) => {
      console.error('[SystemCapture] MediaRecorder error: ' + (e.error?.message || 'unknown'));
      window.captureAPI.captureError('MediaRecorder error: ' + (e.error?.message || 'unknown'));
    };

    audioTracks.forEach(track => {
      track.onended = () => {
        console.warn('[SystemCapture] Audio track ended unexpectedly');
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      };
    });

    mediaRecorder.start(1000);
    console.log('[SystemCapture] MediaRecorder started, recording...');
    window.captureAPI.captureStarted();

  } catch (err) {
    console.error('[SystemCapture] Setup error: ' + (err.message || String(err)));
    window.captureAPI.captureError(err.message || String(err));
  }
});

window.captureAPI.onStop(() => {
  console.log('[SystemCapture] Stop requested, mediaRecorder state: ' + (mediaRecorder ? mediaRecorder.state : 'null'));
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    window.captureAPI.captureStopped(null);
  }
});
