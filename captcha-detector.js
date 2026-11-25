/**
 * Finds the image-grid tiles that show the object a captcha asks for, with
 * the D-FINE large COCO object detector (ustc-community/dfine-large-coco,
 * Apache-2.0) in the half-precision ONNX build published as
 * onnx-community/dfine_l_coco-ONNX. The model is downloaded on first use.
 *
 * Pre- and post-processing follow the Hugging Face RTDetrImageProcessor that
 * the model ships with: a PIL bilinear resize to 640x640, pixels scaled to
 * 0..1 without normalization, and an independent sigmoid per class.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { PNG } = require('pngjs');

const MODEL = {
  url: 'https://huggingface.co/onnx-community/dfine_l_coco-ONNX/resolve/e09b218185400510b68d067bbd0c9379d905ffcd/onnx/model_fp16.onnx',
  sha256: '924eeb4486a6a69b944d949b1f6ac1d5cf5b4716fd4b88d89e49e2a5938f9775',
  file: path.join(os.homedir(), '.cache', 'patchright-mcp', 'dfine_l_coco_fp16.onnx'),
};
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const INPUT_SIZE = 640;
const MIN_SCORE = 0.3;
const MIN_TILE_SHARE = 0.2;
const MIN_OBJECT_SHARE = 0.25;

// COCO class indices, as in the model's config.json id2label.
const TARGETS = [
  { pattern: /\bbicycles?\b/i, labels: [1] },
  { pattern: /\b(?:cars?|taxis?|taxicabs?)\b/i, labels: [2] },
  { pattern: /\b(?:motorcycles?|motorbikes?)\b/i, labels: [3] },
  { pattern: /\b(?:airplanes?|aeroplanes?)\b/i, labels: [4] },
  { pattern: /\bbus(?:es)?\b/i, labels: [5] },
  { pattern: /\btrains?\b/i, labels: [6] },
  { pattern: /\btrucks?\b/i, labels: [7] },
  { pattern: /\bboats?\b/i, labels: [8] },
  { pattern: /\btraffic lights?\b/i, labels: [9] },
  { pattern: /\bfire hydrants?\b/i, labels: [10] },
  { pattern: /\bstop signs?\b/i, labels: [11] },
  { pattern: /\bparking meters?\b/i, labels: [12] },
  { pattern: /\bvehicles?\b/i, labels: [2, 3, 5, 7] },
];

const PICTURE_CACHE_SIZE = 64;

const pictureCache = new Map();
let sessionPromise = null;

/**
 * Maps a captcha instruction such as "Select all images with buses" to the
 * COCO classes to look for. Returns null when the object is not one the
 * model knows.
 */
function targetLabels(instructions) {
  const target = TARGETS.find((item) => item.pattern.test(instructions));
  return target ? target.labels : null;
}

/**
 * Returns the indices of the tiles to click. `tiles` are the tile boxes in
 * pixels relative to the top-left of `png`. A grid of 3 columns holds
 * separate pictures, each detected on its own so it fills the model input; a
 * wider grid splits one photo, so a tile counts when an object covers at
 * least MIN_TILE_SHARE of it, or when it holds at least MIN_OBJECT_SHARE of
 * a small object such as a traffic light.
 */
async function pickTiles(png, tiles, columns, labels) {
  const image = PNG.sync.read(png);
  if (columns <= 3) return pickPictures(image, tiles, labels);

  const objects = await detect(image, labels);
  const picked = [];
  tiles.forEach((tile, index) => {
    if (objects.some((box) => covers(box, tile))) picked.push(index);
  });
  return picked;
}

async function pickPictures(image, tiles, labels) {
  const picked = [];
  for (const [index, tile] of tiles.entries()) {
    if (await pictureShows(crop(image, tile), labels)) picked.push(index);
  }
  return picked;
}

// Grids that replace clicked tiles show the same untouched pictures again on
// the next round, so results are cached by pixel content.
async function pictureShows(picture, labels) {
  const key = crypto.createHash('sha1').update(picture.data).update(labels.join()).digest('hex');
  if (!pictureCache.has(key)) {
    const found = (await detect(picture, labels)).length > 0;
    if (pictureCache.size >= PICTURE_CACHE_SIZE) pictureCache.delete(pictureCache.keys().next().value);
    pictureCache.set(key, found);
  }
  return pictureCache.get(key);
}

function crop(image, tile) {
  const left = Math.max(0, Math.round(tile.x));
  const top = Math.max(0, Math.round(tile.y));
  const width = Math.max(1, Math.min(image.width, Math.round(tile.x + tile.width)) - left);
  const height = Math.max(1, Math.min(image.height, Math.round(tile.y + tile.height)) - top);
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * image.width + left) * 4;
    image.data.copy(data, row * width * 4, start, start + width * 4);
  }
  return { width, height, data };
}

async function detect(image, labels) {
  const ort = require('onnxruntime-node');
  const session = await loadSession(ort);
  const input = new ort.Tensor('float32', toPixelValues(image), [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await session.run({ pixel_values: input });
  const logits = outputs.logits.data;
  const boxes = outputs.pred_boxes.data;
  const [, queries, classes] = outputs.logits.dims;

  const found = [];
  for (let query = 0; query < queries; query++) {
    if (!labels.some((label) => sigmoid(logits[query * classes + label]) >= MIN_SCORE)) continue;
    const [cx, cy, w, h] = boxes.subarray(query * 4, query * 4 + 4);
    found.push({
      x0: (cx - w / 2) * image.width,
      y0: (cy - h / 2) * image.height,
      x1: (cx + w / 2) * image.width,
      y1: (cy + h / 2) * image.height,
    });
  }
  return found;
}

// onnxruntime-node loads a native library, so it is required only once an
// image grid needs solving.
async function loadSession(ort) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureModel();
      return ort.InferenceSession.create(MODEL.file, { executionProviders: ['cpu'] });
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

async function ensureModel() {
  if (fs.existsSync(MODEL.file)) return;
  await fs.promises.mkdir(path.dirname(MODEL.file), { recursive: true });
  const partial = `${MODEL.file}.${process.pid}.part`;
  try {
    const response = await fetch(MODEL.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body)
      throw new Error(`Captcha model download failed: HTTP ${response.status}.`);
    const hash = crypto.createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(partial),
    );
    if (hash.digest('hex') !== MODEL.sha256)
      throw new Error('Captcha model download is corrupt.');
    await fs.promises.rename(partial, MODEL.file);
  } finally {
    await fs.promises.rm(partial, { force: true });
  }
}

function toPixelValues(image) {
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4, j += 3) {
    rgb[j] = image.data[i];
    rgb[j + 1] = image.data[i + 1];
    rgb[j + 2] = image.data[i + 2];
  }
  const wide = resampleAxis(rgb, image.width, image.height, INPUT_SIZE, true);
  const resized = resampleAxis(wide, INPUT_SIZE, image.height, INPUT_SIZE, false);

  const plane = INPUT_SIZE * INPUT_SIZE;
  const values = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      values[channel * plane + pixel] = resized[pixel * 3 + channel] / 255;
  }
  return values;
}

// One pass of PIL's separable bilinear resample (ImagingResample), rounding
// to 8 bits between passes as PIL does. PIL resizes horizontally first.
function resampleAxis(source, width, height, outSize, horizontal) {
  const inSize = horizontal ? width : height;
  const outWidth = horizontal ? outSize : width;
  const outHeight = horizontal ? height : outSize;
  const output = new Uint8Array(outWidth * outHeight * 3);
  const kernels = bilinearKernels(inSize, outSize);

  for (let out = 0; out < outSize; out++) {
    const { start, weights } = kernels[out];
    const lines = horizontal ? height : width;
    for (let line = 0; line < lines; line++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let k = 0; k < weights.length; k++) {
          const at = horizontal ? line * width + start + k : (start + k) * width + line;
          sum += source[at * 3 + channel] * weights[k];
        }
        const target = horizontal ? line * outWidth + out : out * outWidth + line;
        output[target * 3 + channel] = Math.min(255, Math.max(0, Math.round(sum)));
      }
    }
  }
  return output;
}

function bilinearKernels(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale;
  const kernels = [];
  for (let out = 0; out < outSize; out++) {
    const centre = (out + 0.5) * scale;
    const start = Math.max(Math.trunc(centre - support + 0.5), 0);
    const end = Math.min(Math.trunc(centre + support + 0.5), inSize);
    const weights = [];
    let total = 0;
    for (let i = start; i < end; i++) {
      const weight = Math.max(0, 1 - Math.abs((i - centre + 0.5) / filterScale));
      weights.push(weight);
      total += weight;
    }
    kernels.push({ start, weights: weights.map((weight) => (total ? weight / total : 0)) });
  }
  return kernels;
}

function covers(box, tile) {
  const width = Math.max(0, Math.min(tile.x + tile.width, box.x1) - Math.max(tile.x, box.x0));
  const height = Math.max(0, Math.min(tile.y + tile.height, box.y1) - Math.max(tile.y, box.y0));
  const overlap = width * height;
  const boxArea = (box.x1 - box.x0) * (box.y1 - box.y0);
  return overlap >= MIN_TILE_SHARE * tile.width * tile.height || (boxArea > 0 && overlap >= MIN_OBJECT_SHARE * boxArea);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

module.exports = {
  targetLabels,
  pickTiles,
};
