/**
 * Browser camera helpers for document capture.
 *
 * - iOS Safari has no ImageCapture API: photos are full-resolution video frames, so the stream is
 *   opened at the highest resolution the device negotiates (up to the profile's ideal width).
 * - Multi-lens Android phones may open the ultra-wide or macro lens for `facingMode: environment`;
 *   the main lens is picked from the labelled devices once permission has been granted.
 */

export type CameraSession = {
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  torch: boolean;
  settings: MediaTrackSettings;
};

export type FrameRegion = { x: number; y: number; width: number; height: number };
export type GuideRegion = FrameRegion;
export type PhotoGuide = { guide: GuideRegion; viewportWidth: number; viewportHeight: number };

type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  focusMode?: string[];
  zoom?: { min: number; max: number; step: number };
};

export async function openDocumentCamera(idealWidth: number): Promise<CameraSession> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
  const constraints = (deviceId?: string): MediaStreamConstraints => ({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
      width: { ideal: idealWidth },
      height: { ideal: Math.round((idealWidth * 9) / 16) },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  let stream = await navigator.mediaDevices.getUserMedia(constraints());
  const preferred = await preferredRearCamera(stream.getVideoTracks()[0]);
  if (preferred) {
    stopStream(stream);
    stream = await navigator.mediaDevices.getUserMedia(constraints(preferred));
  }
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("camera_unavailable");
  const capabilities = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  // Continuous autofocus is the default on most phones, but some Android builds need it asked for.
  if (capabilities.focusMode?.includes("continuous"))
    await track
      .applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] })
      .catch(() => undefined);
  return { stream, track, label: track.label, torch: Boolean(capabilities.torch), settings: track.getSettings() };
}

/** Returns the device id of the main rear lens when the browser opened another one. */
async function preferredRearCamera(current?: MediaStreamTrack): Promise<string | undefined> {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  const rear = devices.filter((device) => /back|rear|environment|arrière|arriere|خلفي/i.test(device.label));
  if (rear.length < 2) return undefined;
  const secondary = /ultra|wide|macro|tele|depth|zoom|grand angle/i;
  // Chrome on Android labels lenses "camera2 N, facing back"; the lowest index is the main sensor.
  const ranked = rear
    .filter((device) => !secondary.test(device.label))
    .sort((left, right) => lensIndex(left.label) - lensIndex(right.label));
  const main = ranked[0];
  const currentId = current?.getSettings().deviceId;
  return main && main.deviceId !== currentId ? main.deviceId : undefined;
}

function lensIndex(label: string) {
  const match = /camera\d?\s*(\d+)/i.exec(label);
  return match ? Number(match[1]) : 99;
}

export async function setTorch(track: MediaStreamTrack, enabled: boolean) {
  await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
}

export function stopStream(stream?: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Part of the video frame actually visible in an `object-fit: cover` element. */
export function visibleRegion(video: HTMLVideoElement) {
  return visibleFrameRegion(
    video.videoWidth,
    video.videoHeight,
    video.clientWidth || video.videoWidth,
    video.clientHeight || video.videoHeight,
  );
}

function visibleFrameRegion(frameWidth: number, frameHeight: number, boxWidth: number, boxHeight: number) {
  const scale = Math.max(boxWidth / frameWidth, boxHeight / frameHeight);
  const width = Math.min(frameWidth, boxWidth / scale);
  const height = Math.min(frameHeight, boxHeight / scale);
  return { x: (frameWidth - width) / 2, y: (frameHeight - height) / 2, width, height };
}

/** The guide's rectangle, relative to the visible camera viewport. */
export function guideRegion(video: HTMLVideoElement, guide: HTMLElement): GuideRegion {
  const viewport = video.getBoundingClientRect();
  const frame = guide.getBoundingClientRect();
  if (!viewport.width || !viewport.height) throw new Error("Camera viewport is unavailable");
  return {
    x: (frame.left - viewport.left) / viewport.width,
    y: (frame.top - viewport.top) / viewport.height,
    width: frame.width / viewport.width,
    height: frame.height / viewport.height,
  };
}

/** Maps the on-screen guide through `object-fit: cover` to sensor pixels. */
export function frameCropRegion(
  frameWidth: number,
  frameHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  guide: GuideRegion,
): FrameRegion {
  const visible = visibleFrameRegion(frameWidth, frameHeight, viewportWidth, viewportHeight);
  const left = Math.max(0, Math.min(frameWidth - 1, Math.floor(visible.x + guide.x * visible.width)));
  const top = Math.max(0, Math.min(frameHeight - 1, Math.floor(visible.y + guide.y * visible.height)));
  const right = Math.max(
    left + 1,
    Math.min(frameWidth, Math.ceil(visible.x + (guide.x + guide.width) * visible.width)),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(frameHeight, Math.ceil(visible.y + (guide.y + guide.height) * visible.height)),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

let analysisCanvas: HTMLCanvasElement | undefined;

/** Downscales the full sensor frame for live analysis; only the final photo uses the guide crop. */
export function grabAnalysisFrame(video: HTMLVideoElement, maxSide: number) {
  const region: FrameRegion = { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  const scale = Math.min(1, maxSide / Math.max(region.width, region.height));
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  analysisCanvas ??= document.createElement("canvas");
  analysisCanvas.width = width;
  analysisCanvas.height = height;
  const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, width, height);
  return { image: context.getImageData(0, 0, width, height), sourceScale: 1 / scale };
}

/** Native frames for capture. deferCrop preserves the live scene until the worker selects a photo. */
export async function grabBurst(
  video: HTMLVideoElement,
  track: MediaStreamTrack | undefined,
  options: { frames: number; stillCapture: boolean; guide: GuideRegion; deferCrop?: boolean },
): Promise<ImageBitmap[]> {
  const frames: ImageBitmap[] = [];
  const crop = (width: number, height: number) =>
    frameCropRegion(
      width,
      height,
      video.clientWidth || video.videoWidth,
      video.clientHeight || video.videoHeight,
      options.guide,
    );
  const ImageCaptureClass = (
    globalThis as { ImageCapture?: new (track: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }
  ).ImageCapture;
  if (options.stillCapture && track && ImageCaptureClass) {
    try {
      const still = await createImageBitmap(await new ImageCaptureClass(track).takePhoto());
      try {
        const region = crop(still.width, still.height);
        frames.push(
          options.deferCrop
            ? await createImageBitmap(still)
            : await createImageBitmap(still, region.x, region.y, region.width, region.height),
        );
      } finally {
        still.close();
      }
    } catch {
      // Still capture is best effort; video frames remain available on every browser.
    }
  }
  const canvas = document.createElement("canvas");
  const region = options.deferCrop
    ? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight }
    : crop(video.videoWidth, video.videoHeight);
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  for (let index = 0; index < options.frames; index += 1) {
    if (index) await nextVideoFrame(video);
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
    frames.push(await createImageBitmap(canvas));
  }
  return frames;
}

function nextVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    const withCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    if (withCallback.requestVideoFrameCallback) withCallback.requestVideoFrameCallback(() => resolve());
    else window.setTimeout(resolve, 70);
  });
}
