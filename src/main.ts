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
    vf: "scale='min(1280,iw)':-2,fps='min(30,source_fps)'",
    crf: '30',
    preset: 'medium',
    audioBitrate: '96k',
  },
  {
    vf: "scale='min(854,iw)':-2,fps='min(30,source_fps)'",
    crf: '33',
    preset: 'medium',
    audioBitrate: '64k',
  },
  {
    vf: "scale='min(640,iw)':-2,fps='min(24,source_fps)'",
    crf: '35',
    preset: 'medium',
    audioBitrate: '48k',
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

interface JobEl {
  root: HTMLElement;
  state: JobState;
  label: HTMLElement | null;
  value: HTMLElement | null;
  meta: HTMLElement | null;
  track: HTMLElement | null;
  bar: HTMLElement | null;
}

const jobEls = new Map<string, JobEl>();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cardMarkup(job: Job): string {
  const video = `<video src="${job.previewUrl}" class="job-video" muted loop autoplay playsinline preload="auto" aria-hidden="true"></video>`;
  const name = escapeHtml(job.file.name);

  if (job.state === 'done') {
    const grew = (job.savedPercent ?? 0) < 0;
    return `
      <article class="job job--done${grew ? ' job--grew' : ''}" data-id="${job.id}">
        <div class="job-thumb">${video}</div>
        <div class="job-body">
          <p class="job-name" title="${name}">${name}</p>
          <p class="job-meta">${formatBytes(job.originalSize)} → <span class="job-meta-new">${formatBytes(job.outputSize ?? 0)}</span> · ${job.label}</p>
        </div>
        <div class="job-side">
          <a class="btn-icon" href="${job.outputUrl}" download="${job.downloadName}" aria-label="Download" title="Download">
            <i data-lucide="download"></i>
          </a>
          <button type="button" class="job-remove" data-remove="${job.id}" aria-label="Remove" title="Remove">×</button>
        </div>
      </article>
    `;
  }

  if (job.state === 'error') {
    return `
      <article class="job job--error" data-id="${job.id}">
        <div class="job-thumb">${video}</div>
        <div class="job-body">
          <p class="job-name" title="${name}">${name}</p>
          <p class="job-meta"><span class="job-label">${job.label}</span> · <span class="job-value">${job.value}</span></p>
        </div>
        <div class="job-side">
          <button type="button" class="job-remove" data-remove="${job.id}" aria-label="Remove" title="Remove">×</button>
        </div>
      </article>
    `;
  }

  return `
    <article class="job" data-id="${job.id}">
      <div class="job-thumb">${video}</div>
      <div class="job-body">
        <p class="job-name" title="${name}">${name}</p>
        <div class="job-row">
          <span class="job-label">${job.label}</span>
          <span class="job-value">${job.value}</span>
        </div>
        <div class="progress-track is-hidden">
          <div class="progress-bar" style="width: 0%"></div>
        </div>
      </div>
    </article>
  `;
}

function buildCard(job: Job): JobEl {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cardMarkup(job).trim();
  const root = wrapper.firstElementChild as HTMLElement;

  const removeBtn = root.querySelector<HTMLButtonElement>('[data-remove]');
  removeBtn?.addEventListener('click', () => removeJob(job.id));

  return {
    root,
    state: job.state,
    label: root.querySelector('.job-label'),
    value: root.querySelector('.job-value'),
    meta: root.querySelector('.job-meta'),
    track: root.querySelector('.progress-track'),
    bar: root.querySelector('.progress-bar'),
  };
}

function patchCard(entry: JobEl, job: Job) {
  if (entry.label && entry.label.textContent !== job.label) {
    entry.label.textContent = job.label;
  }
  if (entry.value && entry.value.textContent !== job.value) {
    entry.value.textContent = job.value;
  }

  const isActive = job.state !== 'done' && job.state !== 'error';
  const showProgress = job.progress !== null && isActive;
  if (entry.track) {
    entry.track.classList.toggle('is-hidden', !showProgress);
  }
  if (entry.bar) {
    entry.bar.style.width = `${showProgress ? Math.round((job.progress ?? 0) * 100) : 0}%`;
  }
}

function renderJobs() {
  jobList.hidden = jobs.length === 0;

  for (const [id, entry] of [...jobEls]) {
    if (!jobs.some((j) => j.id === id)) {
      entry.root.remove();
      jobEls.delete(id);
    }
  }

  let needsIcons = false;
  for (const job of jobs) {
    let entry = jobEls.get(job.id);

    if (!entry) {
      entry = buildCard(job);
      jobList.appendChild(entry.root);
      jobEls.set(job.id, entry);
      needsIcons = true;
    } else if (entry.state !== job.state) {
      const next = buildCard(job);
      entry.root.replaceWith(next.root);
      jobEls.set(job.id, next);
      entry = next;
      needsIcons = true;
    }

    patchCard(entry, job);
  }

  if (needsIcons) refreshIcons();
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
