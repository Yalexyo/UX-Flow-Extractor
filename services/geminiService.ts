import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult, FrameData } from "../types";

const SYSTEM_INSTRUCTION = `
You are a UX Expert and Interaction Designer. 
Your goal is to analyze a sequence of screenshots extracted from a screen recording of a digital product (Mobile App, Website, or Desktop Application).
The interface may be in Chinese, English, or other languages. You must be able to read and understand Chinese characters on the UI to correctly identify screens and actions.

You need to reconstruct the "User Flow Sitemap" by following these steps:

1. **Identify Screens**: Identify distinct UI states.
   - **IMPORTANT**: Do NOT aggressively filter out similar screens. If two frames look 80-90% similar but have small changes (e.g., a keyboard appearing, a menu expanding, or text being typed), KEEP both screens.
   - **Naming Strategy for Similarity**: If two screens are visually similar (>80%), assign them the EXACT SAME 'label' (e.g., both named "Login Page"). 
   - Use the 'description' to distinguish them (e.g., "Empty state" vs "Typing password").
   - This shared naming allows for "indirect deduplication" during export/review while preserving the granular flow details.
   - Only ignore frames that are 100% identical duplicates or completely broken/blank frames.

2. **Identify Interactions**: Identify the interactions (flows) that connect these screens based on the chronological sequence.
   - For Mobile: Look for taps, swipes.
   - For Web/Desktop: Look for mouse clicks, hover states, or cursor movements leading to changes.
   - If multiple screens have the same Label (e.g., Login -> Login), describe the micro-interaction (e.g., "User types email").

3. **Language Handling**: 
   - Analyze the text on the UI (including Chinese) to understand the context.
   - For 'label', use a short, concise name (2-6 words) suitable for a filename (e.g. "Product Detail", "Settings").
   - For 'edges.label', describe the action (e.g., "点击[按钮]" / "Click [Button]", "Tap [Icon]").
   - For 'description', briefly describe the screen's purpose and state.

4. **Robustness**: The frames are chronological. Ensure the flow connects logically from start to end.
`;

export const analyzeFlowWithGemini = async (frames: FrameData[]): Promise<AnalysisResult> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key is missing in environment variables.");
  }

  const ai = new GoogleGenAI({ apiKey });

  // Prepare the multimodal content
  // We send the images along with their index so the model knows which image is which
  const contentParts = [];
  
  contentParts.push({
    text: `Here are ${frames.length} frames extracted chronologically from a screen recording. Analyze them to build a sitemap.`
  });

  frames.forEach((frame, index) => {
    // Remove data:image/jpeg;base64, prefix
    const base64Data = frame.dataUrl.split(',')[1];
    
    contentParts.push({
      text: `Frame Index: ${index} (Time: ${frame.time.toFixed(1)}s)`
    });
    contentParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64Data
      }
    });
  });

  // Schema Definition
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      screens: {
        type: Type.ARRAY,
        description: "List of distinct, static UI screens identified from the frames.",
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Unique ID for this specific state (must be unique, e.g., 'login_step1', 'login_step2')" },
            label: { type: Type.STRING, description: "Shared name for the screen type (e.g., 'Login Page'). Use same label for similar screens." },
            description: { type: Type.STRING, description: "Brief description of the specific state (e.g. 'Keyboard opens')" },
            frameIndex: { type: Type.INTEGER, description: "The index of the frame that best represents this screen (0-based index from input)." }
          },
          required: ["id", "label", "description", "frameIndex"]
        }
      },
      edges: {
        type: Type.ARRAY,
        description: "The navigation flows between screens.",
        items: {
          type: Type.OBJECT,
          properties: {
            fromId: { type: Type.STRING, description: "ID of the source screen" },
            toId: { type: Type.STRING, description: "ID of the destination screen" },
            label: { type: Type.STRING, description: "The user action (e.g. 'Tap Login', 'Click Submit')" }
          },
          required: ["fromId", "toId", "label"]
        }
      }
    },
    required: ["screens", "edges"]
  };

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: contentParts
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: responseSchema,
      temperature: 0.2 // Low temperature for consistent structural analysis
    }
  });

  let jsonText = response.text || "{}";
  
  // Clean up markdown code blocks if present
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  try {
    return JSON.parse(jsonText) as AnalysisResult;
  } catch (e) {
    console.error("Failed to parse Gemini response", jsonText);
    throw new Error("AI analysis failed to produce valid JSON.");
  }
};