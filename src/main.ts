declare const lucide: { createIcons: () => void } | undefined;

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 32 * 1024 * 1024;
const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm`;

const ENCODE_ARGS = [
  '-i', 'input',
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-crf', '22',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-movflags', '+faststart',
  '-pix_fmt', 'yuv420p',
  'output.mp4',
];

const dropzone = document.getElementById('dropzone') as HTMLLabelElement;
const dropzoneInner = document.getElementById('dropzone-inner') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const statusLabel = document.getElementById('status-label') as HTMLSpanElement;
const statusValue = document.getElementById('status-value') as HTMLSpanElement;
const progressTrack = document.getElementById('progress-track') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const resultEl = document.getElementById('result') as HTMLDivElement;
const originalSizeEl = document.getElementById('original-size') as HTMLSpanElement;
const outputSizeEl = document.getElementById('output-size') as HTMLSpanElement;
const savedPercentEl = document.getElementById('saved-percent') as HTMLSpanElement;
const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let outputUrl: string | null = null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(label: string, value = '') {
  statusEl.hidden = false;
  statusLabel.textContent = label;
  statusValue.textContent = value;
}

function setProgress(ratio: number | null) {
  if (ratio === null) {
    progressTrack.hidden = true;
    progressBar.style.width = '0%';
    return;
  }
  progressTrack.hidden = false;
  progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function resetDropzoneContent() {
  dropzoneInner.innerHTML = `
    <span class="dropzone-icon" aria-hidden="true">
      <i data-lucide="clapperboard"></i>
    </span>
    <p class="dropzone-title">Drop a video here</p>
    <p class="dropzone-sub">or click to pick one</p>
    <p class="dropzone-note">Up to 32MB</p>
  `;
  refreshIcons();
}

function resetUI() {
  if (outputUrl) {
    URL.revokeObjectURL(outputUrl);
    outputUrl = null;
  }
  fileInput.value = '';
  statusEl.hidden = true;
  resultEl.hidden = true;
  dropzone.hidden = false;
  setProgress(null);
  resetDropzoneContent();
}

function refreshIcons() {
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function initTheme() {
  const root = document.documentElement;

  const applyTheme = (theme: 'light' | 'dark') => {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('squeeze-theme', theme);
    refreshIcons();
  };

  themeToggle.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

async function loadFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    instance.on('progress', ({ progress }) => {
      setStatus('Squeezing your video', `${Math.round(progress * 100)}%`);
      setProgress(progress);
    });

    await instance.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    });

    ffmpeg = instance;
    return instance;
  })();

  return loadPromise;
}

function inputExtension(file: File): string {
  const parts = file.name.split('.');
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : 'mp4';
  return ext.replace(/[^a-z0-9]/g, '') || 'mp4';
}

async function compressFile(file: File) {
  if (file.size > MAX_BYTES) {
    setStatus('That file is too big', 'Try one under 32MB');
    return;
  }

  dropzone.hidden = true;
  resultEl.hidden = true;
  setProgress(null);

  try {
    if (!ffmpeg) {
      setStatus('Getting ready', 'Just a moment');
    }

    const encoder = await loadFFmpeg();
    const inputName = `input.${inputExtension(file)}`;

    setStatus('Reading your video');
    await encoder.writeFile(inputName, await fetchFile(file));

    setStatus('Squeezing your video', '0%');
    const args = ENCODE_ARGS.map((arg) => (arg === 'input' ? inputName : arg));
    await encoder.exec(args);

    setStatus('Almost done');
    const data = await encoder.readFile('output.mp4');
    const bytes = data instanceof Uint8Array ? Uint8Array.from(data) : new TextEncoder().encode(String(data));
    const blob = new Blob([bytes], { type: 'video/mp4' });

    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);

    const saved = file.size > 0 ? Math.round((1 - blob.size / file.size) * 100) : 0;

    originalSizeEl.textContent = formatBytes(file.size);
    outputSizeEl.textContent = formatBytes(blob.size);
    savedPercentEl.textContent = saved > 0 ? `${saved}%` : '0%';

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
    downloadLink.href = outputUrl;
    downloadLink.download = `${baseName}-smaller.mp4`;

    statusEl.hidden = true;
    resultEl.hidden = false;
    setProgress(null);
    refreshIcons();

    await encoder.deleteFile(inputName);
    await encoder.deleteFile('output.mp4');
  } catch (error) {
    console.error(error);
    dropzone.hidden = false;
    setStatus('Something went wrong', 'Try a different file');
    setProgress(null);
  }
}

function handleFiles(files: FileList | null) {
  const file = files?.[0];
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    setStatus('That does not look like a video', 'Try another file');
    return;
  }
  void compressFile(file);
}

initTheme();
refreshIcons();
void loadFFmpeg();

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('is-dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('is-dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-dragover');
  handleFiles(e.dataTransfer?.files ?? null);
});

fileInput.addEventListener('change', () => handleFiles(fileInput.files));
resetBtn.addEventListener('click', resetUI);
