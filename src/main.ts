declare const lucide: { createIcons: () => void } | undefined;

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_JOBS = 5;
const MAX_PARALLEL = 3;
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

type JobState = 'queued' | 'preparing' | 'reading' | 'squeezing' | 'done' | 'error';

interface Job {
  id: string;
  file: File;
  previewUrl: string;
  state: JobState;
  label: string;
  value: string;
  progress: number | null;
  outputUrl?: string;
  downloadName?: string;
  savedPercent?: number;
  originalSize: number;
  outputSize?: number;
}

interface WorkerSlot {
  ffmpeg: FFmpeg | null;
  busy: boolean;
  loadPromise: Promise<FFmpeg> | null;
}

const dropzone = document.getElementById('dropzone') as HTMLLabelElement;
const dropzoneNote = document.getElementById('dropzone-note') as HTMLParagraphElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const jobList = document.getElementById('job-list') as HTMLDivElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;

const jobs: Job[] = [];
const workers: WorkerSlot[] = Array.from({ length: MAX_PARALLEL }, () => ({
  ffmpeg: null,
  busy: false,
  loadPromise: null,
}));

let jobIdCounter = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function refreshIcons() {
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function updateJob(job: Job, patch: Partial<Job>) {
  Object.assign(job, patch);
  renderJobs();
}

function updateDropzone() {
  const atLimit = jobs.length >= MAX_JOBS;
  dropzone.classList.toggle('is-disabled', atLimit);
  fileInput.disabled = atLimit;
  dropzoneNote.textContent = atLimit ? '5 videos max' : 'Up to 32MB each';
}

function renderJobs() {
  jobList.hidden = jobs.length === 0;
  jobList.innerHTML = jobs.map((job) => {
    const isActive = job.state !== 'done' && job.state !== 'error';
    const showProgress = job.progress !== null && isActive;

    if (job.state === 'done') {
      return `
        <article class="job job--done" data-id="${job.id}">
          <div class="job-thumb">
            <video src="${job.previewUrl}" class="job-video" muted playsinline preload="metadata" aria-hidden="true"></video>
          </div>
          <div class="job-body">
            <div class="job-row">
              <span class="job-label">${job.savedPercent}% smaller</span>
              <span class="job-meta">${formatBytes(job.originalSize)} → ${formatBytes(job.outputSize ?? 0)}</span>
            </div>
            <div class="job-actions">
              <a class="btn-download" href="${job.outputUrl}" download="${job.downloadName}">
                <i data-lucide="download"></i>
                <span>Download</span>
              </a>
              <button type="button" class="job-remove" data-remove="${job.id}" aria-label="Remove">×</button>
            </div>
          </div>
        </article>
      `;
    }

    if (job.state === 'error') {
      return `
        <article class="job job--error" data-id="${job.id}">
          <div class="job-thumb">
            <video src="${job.previewUrl}" class="job-video" muted playsinline preload="metadata" aria-hidden="true"></video>
          </div>
          <div class="job-body">
            <div class="job-row">
              <span class="job-label">${job.label}</span>
              <span class="job-value">${job.value}</span>
            </div>
            <button type="button" class="job-remove" data-remove="${job.id}" aria-label="Remove">×</button>
          </div>
        </article>
      `;
    }

    return `
      <article class="job" data-id="${job.id}">
        <div class="job-thumb">
          <video src="${job.previewUrl}" class="job-video" muted playsinline preload="metadata" aria-hidden="true"></video>
        </div>
        <div class="job-body">
          <div class="job-row">
            <span class="job-label">${job.label}</span>
            <span class="job-value">${job.value}</span>
          </div>
          <div class="progress-track${showProgress ? '' : ' is-hidden'}">
            <div class="progress-bar" style="width: ${showProgress ? Math.round((job.progress ?? 0) * 100) : 0}%"></div>
          </div>
        </div>
      </article>
    `;
  }).join('');

  jobList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLButtonElement).dataset.remove;
      if (id) removeJob(id);
    });
  });

  refreshIcons();
  updateDropzone();
}

function removeJob(id: string) {
  const index = jobs.findIndex((j) => j.id === id);
  if (index === -1) return;

  const [job] = jobs.splice(index, 1);
  if (job.outputUrl) URL.revokeObjectURL(job.outputUrl);
  URL.revokeObjectURL(job.previewUrl);
  renderJobs();
  pumpQueue();
}

function addJob(file: File) {
  const job: Job = {
    id: `job-${++jobIdCounter}`,
    file,
    previewUrl: URL.createObjectURL(file),
    state: 'queued',
    label: 'Waiting to start',
    value: '',
    progress: null,
    originalSize: file.size,
  };
  jobs.push(job);
  renderJobs();
  pumpQueue();
}

async function loadWorkerFfmpeg(worker: WorkerSlot, job: Job): Promise<FFmpeg> {
  if (worker.ffmpeg) return worker.ffmpeg;
  if (worker.loadPromise) return worker.loadPromise;

  updateJob(job, { state: 'preparing', label: 'Getting ready', value: 'Just a moment' });

  worker.loadPromise = (async () => {
    const instance = new FFmpeg();
    instance.on('progress', ({ progress }) => {
      if (job.state === 'squeezing') {
        updateJob(job, {
          value: `${Math.round(progress * 100)}%`,
          progress,
        });
      }
    });

    await instance.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    });

    worker.ffmpeg = instance;
    return instance;
  })();

  return worker.loadPromise;
}

function inputExtension(file: File): string {
  const parts = file.name.split('.');
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : 'mp4';
  return ext.replace(/[^a-z0-9]/g, '') || 'mp4';
}

async function runJob(worker: WorkerSlot, job: Job) {
  try {
    const encoder = await loadWorkerFfmpeg(worker, job);
    const inputName = `input-${job.id}.${inputExtension(job.file)}`;
    const outputName = `output-${job.id}.mp4`;

    updateJob(job, { state: 'reading', label: 'Reading your video', value: '', progress: null });
    await encoder.writeFile(inputName, await fetchFile(job.file));

    updateJob(job, { state: 'squeezing', label: 'Squeezing your video', value: '0%', progress: 0 });
    const args = ENCODE_ARGS.map((arg) => {
      if (arg === 'input') return inputName;
      if (arg === 'output.mp4') return outputName;
      return arg;
    });
    await encoder.exec(args);

    const data = await encoder.readFile(outputName);
    const bytes = data instanceof Uint8Array ? Uint8Array.from(data) : new TextEncoder().encode(String(data));
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const outputUrl = URL.createObjectURL(blob);
    const saved = job.file.size > 0 ? Math.round((1 - blob.size / job.file.size) * 100) : 0;
    const baseName = job.file.name.replace(/\.[^.]+$/, '') || 'video';

    updateJob(job, {
      state: 'done',
      label: '',
      value: '',
      progress: null,
      outputUrl,
      downloadName: `${baseName}-smaller.mp4`,
      savedPercent: saved > 0 ? saved : 0,
      outputSize: blob.size,
    });

    await encoder.deleteFile(inputName);
    await encoder.deleteFile(outputName);
  } catch (error) {
    console.error(error);
    updateJob(job, {
      state: 'error',
      label: 'Something went wrong',
      value: 'Try a different file',
      progress: null,
    });
  }
}

function pumpQueue() {
  for (const worker of workers) {
    if (worker.busy) continue;

    const job = jobs.find((j) => j.state === 'queued');
    if (!job) continue;

    worker.busy = true;
    void runJob(worker, job).finally(() => {
      worker.busy = false;
      pumpQueue();
    });
  }
}

function handleFiles(files: FileList | null) {
  if (!files?.length) return;

  const remaining = MAX_JOBS - jobs.length;
  if (remaining <= 0) return;

  const toAdd = Array.from(files)
    .filter((f) => f.type.startsWith('video/'))
    .slice(0, remaining);

  if (!toAdd.length) return;

  for (const file of toAdd) {
    if (file.size > MAX_BYTES) {
      const job: Job = {
        id: `job-${++jobIdCounter}`,
        file,
        previewUrl: URL.createObjectURL(file),
        state: 'error',
        label: 'That file is too big',
        value: 'Try one under 32MB',
        progress: null,
        originalSize: file.size,
      };
      jobs.push(job);
      continue;
    }
    addJob(file);
  }

  fileInput.value = '';
  renderJobs();
  pumpQueue();
}

function initTheme() {
  const root = document.documentElement;

  themeToggle.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('squeeze-theme', next);
    refreshIcons();
  });
}

initTheme();
refreshIcons();
updateDropzone();

dropzone.addEventListener('dragover', (e) => {
  if (jobs.length >= MAX_JOBS) return;
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
