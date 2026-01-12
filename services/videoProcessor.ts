import { FrameData } from '../types';

/**
 * Calculates the percentage difference between two image buffers (64x64).
 * Returns 0.0 to 1.0.
 */
const getStructuralDifference = (
  curr: Uint8ClampedArray, 
  prev: Uint8ClampedArray
): number => {
  let diffSum = 0;
  const len = curr.length;
  // Loop through pixels (R, G, B, A)
  // We only care about visual difference, so we sum absolute delta of RGB
  for (let i = 0; i < len; i += 4) {
    const rDiff = Math.abs(curr[i] - prev[i]);
    const gDiff = Math.abs(curr[i + 1] - prev[i + 1]);
    const bDiff = Math.abs(curr[i + 2] - prev[i + 2]);
    
    // Noise floor: Ignore changes smaller than 15/255 (video compression artifacts)
    if (rDiff + gDiff + bDiff > 45) {
      diffSum++;
    }
  }
  
  // Return fraction of pixels that changed significantly
  // divide by (len / 4) because we are counting pixels, not channels
  return diffSum / (len / 4);
};

/**
 * Checks if a frame is a solid color (e.g., black screen, white loading).
 */
const isSolidColor = (data: Uint8ClampedArray): boolean => {
  let rSum = 0, gSum = 0, bSum = 0;
  const totalPixels = data.length / 4;
  
  // Calculate Average
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
  }
  
  const avgR = rSum / totalPixels;
  const avgG = gSum / totalPixels;
  const avgB = bSum / totalPixels;
  
  // Check deviation from average (Scan center and corners)
  // Simplified: just check center pixel vs average
  const centerIdx = Math.floor(totalPixels / 2) * 4;
  const centerDiff = Math.abs(data[centerIdx] - avgR) + Math.abs(data[centerIdx+1] - avgG) + Math.abs(data[centerIdx+2] - avgB);

  return centerDiff < 10; // Very strict solid color check
};

export const extractFramesFromVideo = async (
  videoFile: File,
  scanInterval: number = 0.3, // Check every 0.3s
  maxFrames: number = 50 // Limit total output to prevent UI lag
): Promise<FrameData[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Small canvas for fast structural diffing
    const diffCanvas = document.createElement('canvas');
    const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
    const DIFF_SIZE = 64; // 64x64 grid is sufficient for UI structure
    diffCanvas.width = DIFF_SIZE;
    diffCanvas.height = DIFF_SIZE;

    const frames: FrameData[] = [];
    let prevDiffData: Uint8ClampedArray | null = null;
    
    const url = URL.createObjectURL(videoFile);
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    
    video.onloadeddata = () => {
      // 1. Setup Canvas Size (Max 1280px to save memory)
      const MAX_SIDE = 1280;
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.floor(video.videoWidth * scale);
      canvas.height = Math.floor(video.videoHeight * scale);
      
      let currentTime = 0;
      const duration = video.duration;

      const processFrame = async () => {
        if (currentTime > duration || frames.length >= maxFrames) {
          URL.revokeObjectURL(url);
          resolve(frames);
          return;
        }

        video.currentTime = currentTime;
      };

      video.onseeked = () => {
        if (!diffCtx || !ctx) return;

        // 1. Draw tiny version for Diffing
        diffCtx.drawImage(video, 0, 0, DIFF_SIZE, DIFF_SIZE);
        const currentDiffData = diffCtx.getImageData(0, 0, DIFF_SIZE, DIFF_SIZE).data;

        // 2. Logic to Decide if we Keep this Frame
        let shouldKeep = false;

        if (!prevDiffData) {
          shouldKeep = true; // Always keep first frame
        } else {
          // Compare with previous kept frame
          const diffPercent = getStructuralDifference(currentDiffData, prevDiffData);
          
          // CRITICAL TUNING:
          // > 0.02 (2%) change: Keeps valid UI changes (keyboard popping up, menus).
          // < 0.02 (2%) change: Discards duplicates and video noise.
          if (diffPercent > 0.02 && !isSolidColor(currentDiffData)) {
            shouldKeep = true;
          }
        }

        if (shouldKeep) {
          // Draw full res version only if we are keeping it
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          
          frames.push({ time: currentTime, dataUrl });
          prevDiffData = currentDiffData; // Update baseline
        }

        currentTime += scanInterval;
        processFrame();
      };

      processFrame();
    };

    video.onerror = () => reject(new Error("Failed to load video"));
  });
};