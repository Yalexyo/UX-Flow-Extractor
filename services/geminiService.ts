import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult, FrameData } from "../types";

const SYSTEM_INSTRUCTION = `
You are a UX Expert and Interaction Designer. 
Your goal is to analyze a sequence of screenshots extracted from a screen recording of a digital product (Mobile App, Website, or Desktop Application).
The interface may be in Chinese, English, or other languages. You must be able to read and understand Chinese characters on the UI to correctly identify screens and actions.

You need to reconstruct the "User Flow Sitemap" by following these steps:

1. **Identify Screens**: Identify distinct, unique "Screens" or "Pages". Ignore transition frames (blur, scrolling blur, half-swiped pages, loading spinners) or duplicates.
2. **Identify Interactions**: Identify the interactions (flows) that connect these screens based on the chronological sequence.
   - For Mobile: Look for taps, swipes.
   - For Web/Desktop: Look for mouse clicks, hover states, or cursor movements leading to changes.
3. **Language Handling**: 
   - Analyze the text on the UI (including Chinese) to understand the context.
   - For 'label', use a short, concise name (2-6 words) suitable for a filename (e.g. "Product Detail", "Settings", "Dashboard", "Login Page").
   - For 'description', briefly describe the screen's purpose in the same language as the UI.
   - For 'edges.label', describe the action (e.g., "点击[按钮]" / "Click [Button]", "Tap [Icon]").
4. **Robustness**: The frames are chronological. If Frame 1 is the Home Page and Frame 3 is the Settings Page, and Frame 2 was a transition, link Home -> Settings.
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
            id: { type: Type.STRING, description: "Unique ID (e.g., 'home', 'settings')" },
            label: { type: Type.STRING, description: "Short name of the screen (in UI language)" },
            description: { type: Type.STRING, description: "Brief description of the screen's purpose" },
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