declare const lucide: { createIcons: () => void } | undefined;

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_JOBS = 5;
const MAX_PARALLEL = 3;
const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm`;

const ENCODE_PROFILES = [
  {
    vf: "scale='min(1280,iw)':-2",
    crf: '28',
    preset: 'medium',
    audioBitrate: '96k',
  },
  {
    vf: "scale='min(960,iw)':-2",
    crf: '32',
    preset: 'medium',
    audioBitrate: '64k',
  },
] as const;

function buildEncodeArgs(inputName: string, outputName: string, profile: (typeof ENCODE_PROFILES)[number]): string[] {
  return [
    '-i', inputName,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', profile.vf,
    '-c:v', 'libx264',
    '-preset', profile.preset,
    '-crf', profile.crf,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', profile.audioBitrate,
    '-ac', '2',
    '-movflags', '+faststart',
    outputName,
  ];
}

function fileBytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

function reductionPercent(originalSize: number, outputSize: number): number {
  if (originalSize <= 0) return 0;
  return Math.round((1 - outputSize / originalSize) * 100);
}

function formatReductionLabel(percent: number): string {
  if (percent > 0) return `${percent}% smaller`;
  if (percent < 0) return `${Math.abs(percent)}% larger`;
  return 'Same size';
}

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
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
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
      const grew = (job.savedPercent ?? 0) < 0;
      return `
        <article class="job job--done${grew ? ' job--grew' : ''}" data-id="${job.id}">
          <div class="job-thumb">
            <video src="${job.previewUrl}" class="job-video" muted playsinline preload="metadata" aria-hidden="true"></video>
          </div>
          <div class="job-body">
            <div class="job-row">
              <span class="job-label">${job.label}</span>
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

async function encodeOutput(
  encoder: FFmpeg,
  job: Job,
  inputName: string,
  outputName: string,
): Promise<Uint8Array<ArrayBuffer>> {
  let bestBytes: Uint8Array<ArrayBuffer> | null = null;

  for (let index = 0; index < ENCODE_PROFILES.length; index += 1) {
    const profile = ENCODE_PROFILES[index];
    updateJob(job, {
      state: 'squeezing',
      label: index === 0 ? 'Squeezing your video' : 'Trying a stronger squeeze',
      value: '0%',
      progress: 0,
    });

    const exitCode = await encoder.exec(buildEncodeArgs(inputName, outputName, profile));
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}`);
    }

    const bytes = fileBytes(await encoder.readFile(outputName));
    await encoder.deleteFile(outputName);

    if (!bestBytes || bytes.byteLength < bestBytes.byteLength) {
      bestBytes = bytes;
    }

    if (bytes.byteLength < job.file.size) {
      return bytes;
    }
  }

  if (!bestBytes) {
    throw new Error('No encoded output produced');
  }

  return bestBytes;
}

async function runJob(worker: WorkerSlot, job: Job) {
  try {
    const encoder = await loadWorkerFfmpeg(worker, job);
    const inputName = `input-${job.id}.${inputExtension(job.file)}`;
    const outputName = `output-${job.id}.mp4`;

    updateJob(job, { state: 'reading', label: 'Reading your video', value: '', progress: null });
    await encoder.writeFile(inputName, await fetchFile(job.file));

    const bytes = await encodeOutput(encoder, job, inputName, outputName);
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const outputUrl = URL.createObjectURL(blob);
    const saved = reductionPercent(job.file.size, blob.size);
    const baseName = job.file.name.replace(/\.[^.]+$/, '') || 'video';

    updateJob(job, {
      state: 'done',
      label: formatReductionLabel(saved),
      value: '',
      progress: null,
      outputUrl,
      downloadName: `${baseName}-smaller.mp4`,
      savedPercent: saved,
      outputSize: blob.size,
    });

    await encoder.deleteFile(inputName);
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
