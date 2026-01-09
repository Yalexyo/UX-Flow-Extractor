import { FrameData } from '../types';

/**
 * Calculates the similarity between two image data arrays.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
const calculateSimilarity = (data1: Uint8ClampedArray, data2: Uint8ClampedArray): number => {
  if (data1.length !== data2.length) return 0;
  
  let diffCount = 0;
  // Use a larger step for diffing to be faster, 4 bytes = 1 pixel.
  const step = 4; 
  const totalPixels = data1.length / step;
  
  // Early Exit Threshold: If > 0.5% different, it's considered a new frame.
  // Lowered from 1% to capture more subtle changes (e.g. typing, small toasts).
  const maxDiffPixels = totalPixels * 0.005; 

  for (let i = 0; i < data1.length; i += step) {
    const rDiff = Math.abs(data1[i] - data2[i]);
    const gDiff = Math.abs(data1[i + 1] - data2[i + 1]);
    const bDiff = Math.abs(data1[i + 2] - data2[i + 2]);
    
    // If the color difference of a pixel is significant
    if (rDiff + gDiff + bDiff > 40) {
      diffCount++;
      // Optimization: If frames are already too different, stop checking
      if (diffCount > maxDiffPixels) {
        return 0; 
      }
    }
  }
  
  return 1 - (diffCount / totalPixels);
};

/**
 * Checks if an image is "boring" (low complexity/entropy).
 */
const isLowComplexity = (data: Uint8ClampedArray): boolean => {
  const step = 4 * 5; // Sample every 5th pixel for complexity
  let rSum = 0, gSum = 0, bSum = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += step) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  }

  const avgR = rSum / count;
  const avgG = gSum / count;
  const avgB = bSum / count;

  let varianceSum = 0;
  for (let i = 0; i < data.length; i += step) {
    const dr = data[i] - avgR;
    const dg = data[i + 1] - avgG;
    const db = data[i + 2] - avgB;
    varianceSum += (dr*dr + dg*dg + db*db);
  }
  
  const meanVariance = varianceSum / count;
  const stdDev = Math.sqrt(meanVariance);

  // Lowered threshold from 5 to 2 to ensure we don't skip simple white screens
  return stdDev < 2; 
};

/**
 * Extracts frames from a video file.
 */
export const extractFramesFromVideo = async (
  videoFile: File,
  scanInterval: number = 0.2, // Increased scan rate (5fps) to capture more transition details
  maxFrames: number = 600
): Promise<FrameData[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const diffCanvas = document.createElement('canvas');
    const diffCtx = diffCanvas.getContext('2d');
    // Reduced size for faster diffing (100x100 = 10k pixels)
    // 100px is sufficient to detect UI changes
    const DIFF_SIZE = 100; 
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
      
      // 1. Force Start Frame (Time 0)
      checkPoints.push(0);
      
      // 2. Add interval checkpoints
      for (let t = scanInterval; t < duration; t += scanInterval) {
        checkPoints.push(t);
      }
      
      // 3. Force End Frame
      // We use duration - 0.05s to avoid potential issues with seeking exactly to the end (EOF)
      // which sometimes results in a black frame or error.
      const lastTime = Math.max(0, duration - 0.05);
      
      // Only add if it's not too close to the last interval point (avoid duplicates)
      if (checkPoints.length === 0 || lastTime - checkPoints[checkPoints.length - 1] > 0.1) {
         checkPoints.push(lastTime);
      }

      let currentCheckIndex = 0;
      
      // OPTIMIZATION: Limit output resolution
      // Processing 4K frames is slow and unnecessary for AI analysis.
      // Cap max dimension to 1500px to speed up toDataURL() and reduce memory usage.
      const MAX_DIMENSION = 1500;
      const maxSide = Math.max(video.videoWidth, video.videoHeight);
      const scale = maxSide > MAX_DIMENSION ? MAX_DIMENSION / maxSide : 1.0;

      canvas.width = Math.floor(video.videoWidth * scale);
      canvas.height = Math.floor(video.videoHeight * scale);

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

        // Draw small version for fast analysis
        diffCtx.drawImage(video, 0, 0, DIFF_SIZE, DIFF_SIZE);
        const currentDiffData = diffCtx.getImageData(0, 0, DIFF_SIZE, DIFF_SIZE).data;

        // Determine critical frames
        const isStart = currentCheckIndex === 0;
        const isEnd = currentCheckIndex === checkPoints.length - 1;

        const isBoring = isLowComplexity(currentDiffData);

        let isDuplicate = false;
        // Don't check duplication for the very first frame
        if (lastCapturedDiffData && !isStart) {
          const similarity = calculateSimilarity(lastCapturedDiffData, currentDiffData);
          // High threshold: Frames must be 99.5% identical to be skipped.
          // This allows frames with minor changes (like cursors moving, buttons pressing) to be captured.
          if (similarity > 0.995) {
            isDuplicate = true;
          }
        }

        // Capture Logic:
        // 1. ALWAYS capture Start and End frames.
        // 2. For others, capture only if unique AND not boring.
        let shouldCapture = false;

        if (isStart || isEnd) {
            shouldCapture = true;
        } else {
            shouldCapture = !isBoring && !isDuplicate;
        }
        
        if (shouldCapture) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          // 0.8 quality is a good balance for speed/size
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8); 
          
          frames.push({
            time: video.currentTime,
            dataUrl: dataUrl
          });
          lastCapturedDiffData = currentDiffData;
        } 
        
        currentCheckIndex++;
        processNextCheckpoint();
      });

      processNextCheckpoint();
    });

    video.addEventListener('error', (e) => {
      reject(new Error("Error loading video file."));
    });
  });
};