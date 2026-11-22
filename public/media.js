// O-cultO files, media and voice messages.
//
// Files are read on your device, split into pieces, and every piece is
// encrypted with the chat's keys before it leaves (see app.js). The receiver
// puts them back together in memory and shows them from a temporary in-memory
// link that is thrown away when the chat ends. Nothing is written to disk
// unless you choose to save a file yourself.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHUNK_BYTES = 96 * 1024;
export const MAX_VOICE_SECONDS = 5 * 60;

// Only these types are shown inside the chat. Everything else (including
// HTML and SVG, which could run code) is offered as a plain download.
const INLINE = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
  audio: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/x-m4a'],
};

/** 'image' | 'video' | 'audio' | 'file' for a claimed MIME type. */
export function displayKind(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  for (const [kind, list] of Object.entries(INLINE)) if (list.includes(base)) return kind;
  return 'file';
}

/** The type the in-memory copy gets. Unknown types become a plain download. */
export function blobType(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return displayKind(base) === 'file' ? 'application/octet-stream' : base;
}

export function cleanFileName(name) {
  const n = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  return n || 'file';
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Fill a chat bubble for a file. Returns controls for progress, done and fail.
 * meta: { name, size, mime, voice, duration }
 */
export function fileBubble(li, meta, onUrl) {
  const box = document.createElement('div');
  box.className = 'file';
  const label = document.createElement('div');
  label.className = 'file-label';
  label.textContent = meta.voice
    ? `🎤 Voice message${meta.duration ? ' · ' + formatDuration(meta.duration) : ''}`
    : `${meta.name} · ${formatSize(meta.size)}`;
  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  box.append(label, bar);
  li.prepend(box);

  return {
    progress(p) { bar.value = p; },
    fail(text) {
      bar.remove();
      label.textContent = `${meta.voice ? 'Voice message' : meta.name}: ${text}`;
      box.classList.add('failed');
    },
    done(blob) {
      const url = URL.createObjectURL(blob);
      onUrl(url);
      bar.remove();
      const kind = meta.voice ? 'audio' : displayKind(blob.type);
      let el;
      if (kind === 'image') {
        el = document.createElement('img');
        el.alt = meta.name;
        el.src = url;
        el.loading = 'lazy';
      } else if (kind === 'video' || kind === 'audio') {
        el = document.createElement(kind);
        el.controls = true;
        el.preload = 'metadata';
        el.setAttribute('playsinline', '');
        el.src = url;
      }
      if (el) {
        el.className = 'media';
        box.insertBefore(el, label);
      }
      // Always offer a way to save it.
      if (!meta.voice) {
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name;
        a.className = 'file-save';
        a.textContent = el ? 'Save' : `⬇ ${meta.name} · ${formatSize(meta.size)}`;
        if (el) box.append(a);
        else label.replaceWith(a);
      }
    },
  };
}

/** Records one voice message from the microphone. */
export class VoiceRecorder {
  constructor({ onTick, onAutoStop }) {
    this.onTick = onTick;
    this.onAutoStop = onAutoStop;
    this.rec = null;
  }

  get active() { return !!this.rec; }

  async start() {
    if (this.rec) return;
    if (typeof MediaRecorder === 'undefined') throw new Error('unsupported');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
    this.parts = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.parts.push(e.data); };
    this.rec.start(500);
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const sec = this.seconds();
      this.onTick(sec);
      if (sec >= MAX_VOICE_SECONDS) this.onAutoStop();
    }, 250);
    this.onTick(0);
  }

  seconds() { return this.rec ? (Date.now() - this.startedAt) / 1000 : 0; }

  /** Stop. Resolves to { blob, duration } when keep is true, else null. */
  stop(keep) {
    const rec = this.rec;
    if (!rec) return Promise.resolve(null);
    const duration = this.seconds();
    clearInterval(this.timer);
    this.rec = null;
    return new Promise((resolve) => {
      rec.onstop = () => {
        for (const t of this.stream.getTracks()) t.stop();
        this.stream = null;
        const parts = this.parts;
        this.parts = [];
        if (!keep || !parts.length) return resolve(null);
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        resolve({ blob: new Blob(parts, { type }), duration });
      };
      try { rec.stop(); } catch { rec.onstop(); }
    });
  }
}
