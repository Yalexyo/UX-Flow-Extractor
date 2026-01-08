import { FrameData } from '../types';

/**
 * Calculates the similarity between two image data arrays.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
const calculateSimilarity = (data1: Uint8ClampedArray, data2: Uint8ClampedArray): number => {
  if (data1.length !== data2.length) return 0;
  
  let diffCount = 0;
  const totalPixels = data1.length / 4;
  
  // Optimization: Check every 4th pixel to speed up processing without losing much accuracy
  const step = 4 * 4; 
  for (let i = 0; i < data1.length; i += step) {
    const rDiff = Math.abs(data1[i] - data2[i]);
    const gDiff = Math.abs(data1[i + 1] - data2[i + 1]);
    const bDiff = Math.abs(data1[i + 2] - data2[i + 2]);
    
    // If the color difference of a pixel is significant
    if (rDiff + gDiff + bDiff > 40) {
      diffCount++;
    }
  }
  
  // Adjusted calculation: normalize based on the step size
  return 1 - (diffCount / (totalPixels / (step/4)));
};

/**
 * Checks if an image is "boring" (low complexity/entropy).
 * Useful for filtering out blank loading screens, fade-to-black transitions, 
 * or screens with just a tiny spinner in the middle.
 */
const isLowComplexity = (data: Uint8ClampedArray): boolean => {
  const step = 4 * 10; // Sample every 10th pixel
  let rSum = 0, gSum = 0, bSum = 0;
  let count = 0;

  // 1. Calculate Average Color
  for (let i = 0; i < data.length; i += step) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  }

  const avgR = rSum / count;
  const avgG = gSum / count;
  const avgB = bSum / count;

  // 2. Calculate Standard Deviation (Variance from average)
  let varianceSum = 0;
  for (let i = 0; i < data.length; i += step) {
    const dr = data[i] - avgR;
    const dg = data[i + 1] - avgG;
    const db = data[i + 2] - avgB;
    varianceSum += (dr*dr + dg*dg + db*db);
  }
  
  const meanVariance = varianceSum / count;
  const stdDev = Math.sqrt(meanVariance);

  // Thresholds explained:
  // < 5: Pure solid color (Black screen, White screen)
  // 5 - 20: Very flat gradients or solid color with minor noise
  // 20 - 35: Loading screens with small spinners or very sparse text
  // > 35: Standard UI pages (even minimal login screens usually hit 40+)
  
  return stdDev < 30; 
};

/**
 * Extracts frames from a video file.
 * Strategy: High Frequency Sampling + Aggressive Filtering.
 * We scan often (0.6s) to catch fast interactions, but use strict complexity 
 * and deduplication checks to remove the noise.
 */
export const extractFramesFromVideo = async (
  videoFile: File,
  scanInterval: number = 0.6, 
  maxFrames: number = 100
): Promise<FrameData[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    
    // Main canvas for final output
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Tiny canvas for fast pixel diffing and complexity check
    const diffCanvas = document.createElement('canvas');
    const diffCtx = diffCanvas.getContext('2d');
    const DIFF_SIZE = 200; 
    diffCanvas.width = DIFF_SIZE;
    diffCanvas.height = DIFF_SIZE;

    const frames: FrameData[] = [];
    let lastCapturedDiffData: Uint8ClampedArray | null = null;
    
    const url = URL.createObjectURL(videoFile);
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    video.addEventListener('loadeddata', async () => {
      const duration = video.duration;
      
      const checkPoints: number[] = [];
      for (let t = 0; t < duration; t += scanInterval) {
        checkPoints.push(t);
      }
      
      // Ensure we explicitly target the very end of the video
      // Reduced threshold from 0.2 to 0.05 to ensure we capture the final state even if close to the interval
      if (duration > 0.05 && (checkPoints.length === 0 || duration - checkPoints[checkPoints.length - 1] > 0.05)) {
        checkPoints.push(duration - 0.05); 
      }

      let currentCheckIndex = 0;
      
      const scale = 1.0; 
      canvas.width = video.videoWidth * scale;
      canvas.height = video.videoHeight * scale;

      const processNextCheckpoint = () => {
        if (currentCheckIndex >= checkPoints.length || frames.length >= maxFrames) {
          URL.revokeObjectURL(url);
          resolve(frames);
          return;
        }

        const time = checkPoints[currentCheckIndex];
        video.currentTime = time;
      };

      video.addEventListener('seeked', () => {
        if (!ctx || !diffCtx) return;

        // A. Draw to diff canvas for comparison/analysis
        diffCtx.drawImage(video, 0, 0, DIFF_SIZE, DIFF_SIZE);
        const currentDiffData = diffCtx.getImageData(0, 0, DIFF_SIZE, DIFF_SIZE).data;

        // Flags
        const isFirstCheckpoint = currentCheckIndex === 0;
        const isLastCheckpoint = currentCheckIndex === checkPoints.length - 1;

        // B. Complexity Check
        const isBoring = isLowComplexity(currentDiffData);

        // C. Deduplication Check
        let isDuplicate = false;
        if (lastCapturedDiffData) {
          const similarity = calculateSimilarity(lastCapturedDiffData, currentDiffData);
          // If 90% identical, we consider it the same screen
          if (similarity > 0.90) {
            isDuplicate = true;
          }
        }

        // Logic:
        // 1. First Frame: ALWAYS capture.
        // 2. Last Frame: ALWAYS capture. We force this because the final state of a flow 
        //    (e.g. "Success" toast) is often critical, even if it looks similar to the previous frame (duplicate).
        // 3. Middle Frames: Must NOT be boring AND NOT be duplicate.

        let shouldCapture = false;

        if (isFirstCheckpoint || isLastCheckpoint) {
            shouldCapture = true;
        } else {
            shouldCapture = !isBoring && !isDuplicate;
        }
        
        if (shouldCapture) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85); 
          
          frames.push({
            time: video.currentTime,
            dataUrl: dataUrl
          });
          lastCapturedDiffData = currentDiffData;
        } 
        
        // D. Move to next
        currentCheckIndex++;
        processNextCheckpoint();
      });

      // Start the loop
      processNextCheckpoint();
    });

    video.addEventListener('error', (e) => {
      reject(new Error("Error loading video file."));
    });
  });
};