export interface FrameData {
  time: number;
  dataUrl: string;
}

export interface ScreenNode {
  id: string;
  label: string;
  description: string;
  frameIndex: number; // Index in the original extracted frames array
  x?: number; // Calculated for layout
  y?: number;
}

export interface FlowEdge {
  fromId: string;
  toId: string;
  label: string; // The user action, e.g., "Tap Login"
}

export interface AnalysisResult {
  screens: ScreenNode[];
  edges: FlowEdge[];
}

export enum AppState {
  IDLE = 'IDLE',
  EXTRACTING_FRAMES = 'EXTRACTING_FRAMES',
  ANALYZING_AI = 'ANALYZING_AI',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR'
}
