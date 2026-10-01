import assert from "node:assert/strict";
import test from "node:test";
import { frameCropRegion, grabAnalysisFrame, grabBurst, guideRegion } from "../src/lib/camera.ts";

test("live analysis keeps the full camera frame when the final-photo guide is narrow", () => {
  const originalDocument = globalThis.document;
  let source;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args) => { source = args; },
        getImageData: (_x, _y, width, height) => ({ width, height }),
      }),
    }),
  };
  try {
    const video = { videoWidth: 1920, videoHeight: 1080, clientWidth: 400, clientHeight: 800 };
    const frame = grabAnalysisFrame(video, 1280);
    assert.deepEqual(source.slice(1), [0, 0, 1920, 1080, 0, 0, 1280, 720]);
    assert.equal(frame.image.width, 1280);
    assert.equal(frame.image.height, 720);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("the phone guide selects only its visible rectangle from video and still photos", () => {
  const guide = { x: 0.1, y: 0.25, width: 0.8, height: 0.25 };
  assert.deepEqual(
    guideRegion(
      { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 800 }) },
      { getBoundingClientRect: () => ({ left: 50, top: 220, width: 320, height: 200 }) },
    ),
    guide,
  );
  assert.deepEqual(frameCropRegion(1920, 1080, 400, 800, guide), {
    x: 744, y: 270, width: 432, height: 270,
  });
  assert.deepEqual(frameCropRegion(4032, 3024, 400, 800, guide), {
    x: 1411, y: 756, width: 1210, height: 756,
  });
});

test("the photo burst analyzes and uploads only guide pixels", async () => {
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let source;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args) => { source = args; } }),
    }),
  };
  globalThis.createImageBitmap = async (canvas) => ({ width: canvas.width, height: canvas.height, close() {} });
  try {
    const video = { videoWidth: 1920, videoHeight: 1080, clientWidth: 400, clientHeight: 800 };
    const frames = await grabBurst(video, undefined, {
      frames: 1,
      stillCapture: false,
      guide: { x: 0.1, y: 0.25, width: 0.8, height: 0.25 },
    });
    assert.deepEqual(source.slice(1), [744, 270, 432, 270, 0, 0, 432, 270]);
    assert.equal(frames[0].width, 432);
    assert.equal(frames[0].height, 270);
  } finally {
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test("deferred cropping preserves the whole scene for final quality analysis", async () => {
  const originalDocument = globalThis.document;
  const originalBitmap = globalThis.createImageBitmap;
  let source;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (...args) => { source = args; } }) }) };
  globalThis.createImageBitmap = async (canvas) => ({ width: canvas.width, height: canvas.height, close() {} });
  try {
    const frames = await grabBurst({ videoWidth: 1920, videoHeight: 1080, clientWidth: 400, clientHeight: 800 }, undefined, {
      frames: 1, stillCapture: false, guide: { x: 0.1, y: 0.25, width: 0.8, height: 0.25 }, deferCrop: true,
    });
    assert.deepEqual(source.slice(1), [0, 0, 1920, 1080, 0, 0, 1920, 1080]);
    assert.equal(frames[0].width, 1920);
  } finally { globalThis.document = originalDocument; globalThis.createImageBitmap = originalBitmap; }
});
