import { FrameData } from '../types';

/**
 * Calculates the similarity between two image data arrays.
 * Uses a pixel comparison to be performant.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
const calculateSimilarity = (data1: Uint8ClampedArray, data2: Uint8ClampedArray): number => {
  if (data1.length !== data2.length) return 0;
  
  let diffCount = 0;
  const totalPixels = data1.length / 4;
  
  // Optimization: Check every pixel (RGBA)
  for (let i = 0; i < data1.length; i += 4) {
    const rDiff = Math.abs(data1[i] - data2[i]);
    const gDiff = Math.abs(data1[i + 1] - data2[i + 1]);
    const bDiff = Math.abs(data1[i + 2] - data2[i + 2]);
    
    // If the color difference of a pixel is significant
    // Threshold lowered to 20 to be extremely sensitive
    if (rDiff + gDiff + bDiff > 20) {
      diffCount++;
    }
  }
  
  return 1 - (diffCount / totalPixels);
};

/**
 * Extracts frames from a video file using smart deduplication.
 * Strategy:
 * 1. Scan frequently (every 0.5s).
 * 2. Compare current frame with the last captured frame using high-res diff.
 * 3. Only keep frames that are visually different ( deduplication ).
 * 4. Always ensure the final frame of the video is captured.
 */
export const extractFramesFromVideo = async (
  videoFile: File,
  scanInterval: number = 0.5, 
  maxFrames: number = 80
): Promise<FrameData[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    
    // Main canvas for final output
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Tiny canvas for fast pixel diffing
    // Size 320 ensures we can detect content/text changes accurately
    const diffCanvas = document.createElement('canvas');
    const diffCtx = diffCanvas.getContext('2d');
    const DIFF_SIZE = 320; 
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
      
      // 1. Build a schedule of timestamps to check
      const checkPoints: number[] = [];
      for (let t = 0; t < duration; t += scanInterval) {
        checkPoints.push(t);
      }
      
      // 2. Crucial: Ensure the exact end of the video is checked
      if (duration - (checkPoints[checkPoints.length - 1] || 0) > 0.1) {
        checkPoints.push(duration);
      } else if (checkPoints.length > 0) {
        checkPoints[checkPoints.length - 1] = duration;
      }

      let currentCheckIndex = 0;
      
      // Set output resolution
      // Changed from 0.5 to 1.0 to ensure high clarity for UI text
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

        // A. Draw to diff canvas for comparison
        diffCtx.drawImage(video, 0, 0, DIFF_SIZE, DIFF_SIZE);
        const currentDiffData = diffCtx.getImageData(0, 0, DIFF_SIZE, DIFF_SIZE).data;

        // B. Decide if we should keep this frame
        let isDifferent = true;
        
        if (lastCapturedDiffData) {
          const similarity = calculateSimilarity(lastCapturedDiffData, currentDiffData);
          // Threshold: If > 99% similar, assume it's the same screen.
          // Increased from 0.98 to 0.99 to capture very subtle changes.
          if (similarity > 0.99) {
            isDifferent = false;
          }
        }

        // Always keep the very first frame and the very last frame
        const isLastCheckpoint = currentCheckIndex === checkPoints.length - 1;
        if (frames.length === 0 || isLastCheckpoint) {
             isDifferent = true;
             // Dedupe last frame if practically identical (99.8%)
             if (lastCapturedDiffData && calculateSimilarity(lastCapturedDiffData, currentDiffData) > 0.998) {
                 isDifferent = false; 
             }
        }

        // C. Capture high-res if different
        if (isDifferent) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          // Increased quality from 0.6 to 0.85 for clearer text
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