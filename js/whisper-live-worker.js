/**
 * VoiceScribe — オフライン Whisper 推論（メインスレッドを止めない）。
 *
 * whisper.cpp のブラウザ版は pthread / SharedArrayBuffer 前提で、
 * GitHub Pages は COOP/COEP を付けられない。ここは transformers.js 3.8 の
 * onnx-community Whisper（q8）を、WebGPU が使えなければ WASM 1 スレッドで動かす。
 * language は呼び出し側が渡し、task は transcribe 固定。
 */

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let transformers = null;
let pipe = null;
let pipeKey = '';
let deviceUsed = '';
let fallbackNote = '';
let webgpuReason = '';
const bannedDevices = new Set();

/**
 * @param {object} message
 */
function publish(message) {
  self.postMessage(message);
}

/**
 * @param {object} data
 */
function onProgress(data) {
  publish({
    type: 'progress',
    status: data && data.status,
    file: data && data.file,
    loaded: data && data.loaded,
    total: data && data.total,
    progress: data && data.progress
  });
}

/**
 * @returns {Promise<boolean>}
 */
async function hasWebGpu() {
  try {
    if (!navigator.gpu || !navigator.gpu.requestAdapter) {
      webgpuReason = 'navigator.gpu がない';
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      webgpuReason = 'requestAdapter が null';
      return false;
    }
    webgpuReason = '';
    return true;
  } catch (error) {
    webgpuReason = error && error.message ? error.message : String(error);
    return false;
  }
}

/**
 * @param {string} modelId
 * @param {'webgpu'|'wasm'} device
 */
async function createPipeline(modelId, device) {
  const { pipeline, env } = transformers;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }
  // WebGPU の q8 は ORT が落とすことが多い。WASM は q8 のまま（iPhone の容量）。
  const dtype = device === 'webgpu' ? 'fp16' : 'q8';
  return pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype,
    progress_callback: onProgress
  });
}

/**
 * @param {string} modelId
 */
async function ensurePipeline(modelId) {
  const key = modelId;
  if (pipe && pipeKey === key) {
    publish({ type: 'ready', modelId, device: deviceUsed, fallback: fallbackNote, webgpuReason });
    return;
  }
  if (!transformers) {
    transformers = await import(TRANSFORMERS_URL);
  }
  pipe = null;
  pipeKey = '';
  const devices = [];
  if (await hasWebGpu()) devices.push('webgpu');
  devices.push('wasm');
  const usable = devices.filter((device) => !bannedDevices.has(device));
  let lastError = null;
  for (let i = 0; i < usable.length; i++) {
    const device = usable[i];
    try {
      pipe = await createPipeline(modelId, device);
      pipeKey = key;
      deviceUsed = device;
      publish({
        type: 'ready',
        modelId,
        device,
        fallback: fallbackNote,
        webgpuReason
      });
      return;
    } catch (error) {
      lastError = error;
      pipe = null;
      const message = error && error.message ? error.message : String(error);
      if (device === 'webgpu') fallbackNote = message;
      publish({
        type: 'status',
        text: device === 'webgpu'
          ? 'WebGPU では読めなかったので WASM に切り替えます'
          : `モデルを読めません: ${message}`
      });
    }
  }
  throw lastError || new Error('Whisper を初期化できません');
}

/**
 * @param {object} msg
 */
async function transcribe(msg) {
  await ensurePipeline(msg.modelId);
  const audio = msg.pcm;
  const started = Date.now();
  let output;
  try {
    output = await pipe(audio, {
      language: msg.language || 'ja',
      task: 'transcribe',
      return_timestamps: false
    });
  } catch (error) {
    if (deviceUsed === 'webgpu') {
      bannedDevices.add('webgpu');
      fallbackNote = error && error.message ? error.message : String(error);
      pipe = null;
      pipeKey = '';
      deviceUsed = '';
      publish({ type: 'status', text: 'WebGPU の推論に失敗したので WASM でやり直します' });
      await ensurePipeline(msg.modelId);
      output = await pipe(audio, {
        language: msg.language || 'ja',
        task: 'transcribe',
        return_timestamps: false
      });
    } else {
      throw error;
    }
  }
  const text = output && output.text ? String(output.text).trim() : '';
  publish({
    type: 'text',
    id: msg.id,
    session: msg.session,
    text,
    ms: Date.now() - started,
    device: deviceUsed,
    samples: audio ? audio.length : 0
  });
}

let chain = Promise.resolve();

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'release') {
    pipe = null;
    pipeKey = '';
    deviceUsed = '';
    publish({ type: 'released' });
    return;
  }
  if (msg.type !== 'load' && msg.type !== 'transcribe') return;
  chain = chain.then(() => {
    if (msg.type === 'load') return ensurePipeline(msg.modelId);
    return transcribe(msg);
  }).catch((error) => {
    publish({
      type: 'error',
      id: msg.id,
      session: msg.session,
      message: error && error.message ? error.message : String(error)
    });
  });
};
