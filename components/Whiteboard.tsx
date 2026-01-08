import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { AnalysisResult, FrameData } from '../types';
import { Move, Plus, Minus, RotateCcw } from 'lucide-react';
// @ts-ignore
import html2canvas from 'html2canvas';
// @ts-ignore
import JSZip from 'jszip';
// @ts-ignore
import FileSaver from 'file-saver';

interface WhiteboardProps {
  data: AnalysisResult;
  frames: FrameData[];
}

export interface WhiteboardHandle {
  exportCards: (onProgress: (current: number, total: number) => void) => Promise<void>;
}

interface LayoutNode {
  id: string;
  label: string;
  description: string;
  frameIndex: number;
  x: number;
  y: number;
  level: number;
  orderInLevel: number;
}

// --- Layout Algorithm ---
const calculateInitialLayout = (data: AnalysisResult): { nodes: LayoutNode[], width: number, height: number } => {
  // 1. Adjusted dimensions for Web Page compatibility
  // Increased width to 1024px to accommodate desktop screenshots without cropping horizontally.
  const nodeWidth = 1024; 
  const nodeHeight = 800; // Fixed total height
  const gapX = 100; 
  const gapY = 150; 

  const levels: Record<string, number> = {};
  const processed = new Set<string>();
  const incomingEdges = new Set(data.edges.map(e => e.toId));
  
  const roots = data.screens.filter(s => !incomingEdges.has(s.id));
  const startNodes = roots.length > 0 ? roots : [data.screens[0]];
  
  const queue: { id: string, level: number }[] = startNodes.map(n => ({ id: n.id, level: 0 }));
  
  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    levels[id] = level;
    const children = data.edges.filter(e => e.fromId === id).map(e => e.toId);
    children.forEach(childId => {
      if (!processed.has(childId)) queue.push({ id: childId, level: level + 1 });
    });
  }

  data.screens.forEach(s => {
    if (levels[s.id] === undefined) levels[s.id] = 0;
  });

  const nodesByLevel: Record<number, string[]> = {};
  Object.entries(levels).forEach(([id, level]) => {
    if (!nodesByLevel[level]) nodesByLevel[level] = [];
    nodesByLevel[level].push(id);
  });

  const maxLevel = Math.max(...Object.values(levels));
  const finalPositions: Record<string, number> = {};
  const getFrameIndex = (id: string) => data.screens.find(s => s.id === id)?.frameIndex || 0;

  for (let l = 0; l <= maxLevel; l++) {
    const nodeIds = nodesByLevel[l] || [];
    if (l === 0) {
      nodeIds.forEach((id, idx) => finalPositions[id] = idx);
    } else {
      const nodeWeights = nodeIds.map(id => {
        const parents = data.edges.filter(e => e.toId === id).map(e => e.fromId);
        const validParents = parents.filter(pid => finalPositions[pid] !== undefined);
        let parentWeight = validParents.length === 0 ? 9999 : validParents.reduce((sum, pid) => sum + finalPositions[pid], 0) / validParents.length;
        return { id, parentWeight, timeWeight: getFrameIndex(id) };
      });

      nodeWeights.sort((a, b) => {
        if (Math.abs(a.parentWeight - b.parentWeight) > 0.01) return a.parentWeight - b.parentWeight;
        return a.timeWeight - b.timeWeight;
      });
      nodeWeights.forEach((nw, idx) => finalPositions[nw.id] = idx);
    }
  }

  const levelWidths: Record<number, number> = {};
  for (let l = 0; l <= maxLevel; l++) {
    const count = nodesByLevel[l]?.length || 0;
    levelWidths[l] = count * (nodeWidth + gapX) - gapX;
  }
  const maxRowWidth = Math.max(...Object.values(levelWidths), 0);

  const nodes = data.screens.map(screen => {
    const level = levels[screen.id] || 0;
    const order = finalPositions[screen.id] || 0;
    const y = level * (nodeHeight + gapY) + 100;
    const currentRowWidth = levelWidths[level] || 0;
    const centerOffset = (maxRowWidth - currentRowWidth) / 2;
    const x = centerOffset + (order * (nodeWidth + gapX)) + 100;
    return { ...screen, level, orderInLevel: order, x, y };
  });

  return { 
    nodes, 
    width: maxRowWidth + 600, 
    height: (maxLevel + 1) * (nodeHeight + gapY) + 400 
  };
};

export const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(({ data, frames }, ref) => {
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 2000, h: 2000 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 0.4 }); // Zoomed out default for large cards
  
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'IDLE' | 'PANNING'>('IDLE');
  const [dragStartMousePos, setDragStartMousePos] = useState({ x: 0, y: 0 });
  const [dragStartTransform, setDragStartTransform] = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);

  // Expose export function to parent
  useImperativeHandle(ref, () => ({
    exportCards: async (onProgress) => {
        const zip = new JSZip();
        
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            onProgress(i + 1, nodes.length);

            const elementId = `node-card-${node.id}`;
            const element = document.getElementById(elementId);
            
            if (element) {
                const yAxis = node.level + 1;
                const xAxis = node.orderInLevel + 1;
                let filePrefix = `${yAxis}.${xAxis}`;
                if (node.level === 0 && node.orderInLevel === 0) filePrefix = "1";

                const safeLabel = node.label.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_'); 
                const filename = `${filePrefix}-${safeLabel}.png`;

                try {
                    const canvas = await html2canvas(element, {
                        scale: 2, 
                        backgroundColor: '#ffffff', 
                        logging: false,
                        useCORS: true,
                        onclone: (clonedDoc: Document) => {
                           const style = clonedDoc.createElement('style');
                           style.innerHTML = `
                             * { 
                               font-feature-settings: "liga" 0, "clig" 0, "calt" 0 !important; 
                               font-variant-ligatures: none !important;
                               font-kerning: normal !important;
                             }
                           `;
                           clonedDoc.head.appendChild(style);
                        }
                    });
                    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (blob) zip.file(filename, blob);
                } catch (err) {
                    console.error(`Failed to capture node ${node.id}`, err);
                }
            }
        }
        const content = await zip.generateAsync({ type: "blob" });
        FileSaver.saveAs(content, "ux_flow_cards.zip");
    }
  }));

  useEffect(() => {
    if (data && data.screens.length > 0) {
      const layout = calculateInitialLayout(data);
      setNodes(layout.nodes);
      setCanvasSize({ 
        w: Math.max(layout.width + 1000, 3000), 
        h: Math.max(layout.height + 1000, 3000) 
      });
      // Center the view initially
      const containerW = containerRef.current?.clientWidth || window.innerWidth;
      const initialX = (containerW - layout.width * 0.4) / 2; // Adjusted for new scale
      setTransform({ x: initialX, y: 50, scale: 0.4 }); 
    }
  }, [data]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') { 
        e.preventDefault(); 
        setIsSpacePressed(true);
        setInteractionMode('PANNING');
        if (containerRef.current) containerRef.current.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        setIsSpacePressed(false);
        setInteractionMode('IDLE');
        if (containerRef.current) containerRef.current.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed || e.button === 1 || e.button === 0) {
      setInteractionMode('PANNING');
      setDragStartMousePos({ x: e.clientX, y: e.clientY });
      setDragStartTransform({ x: transform.x, y: transform.y });
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (interactionMode === 'PANNING') {
      const dx = e.clientX - dragStartMousePos.x;
      const dy = e.clientY - dragStartMousePos.y;
      setTransform(prev => ({ ...prev, x: dragStartTransform.x + dx, y: dragStartTransform.y + dy }));
    }
  };

  const handleMouseUp = () => {
    if (interactionMode === 'PANNING') {
      setInteractionMode(isSpacePressed ? 'PANNING' : 'IDLE');
      if (containerRef.current) containerRef.current.style.cursor = isSpacePressed ? 'grab' : 'default';
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomSensitivity = 0.001;
      const delta = -e.deltaY * zoomSensitivity;
      const newScale = Math.min(Math.max(transform.scale + delta, 0.1), 3);
      setTransform(prev => ({ ...prev, scale: newScale }));
    } else {
       setTransform(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-50">
      {/* Zoom Controls */}
      <div className="absolute bottom-6 right-6 z-50 flex flex-col gap-2 bg-white p-2 rounded-xl shadow-lg border border-gray-100">
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform(t => ({...t, scale: Math.min(t.scale + 0.1, 3)}))}>
          <Plus className="w-5 h-5" />
        </button>
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform(t => ({...t, scale: Math.max(t.scale - 0.1, 0.1)}))}>
          <Minus className="w-5 h-5" />
        </button>
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform({ x: 0, y: 0, scale: 0.4 })}>
           <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute top-6 left-6 z-50 bg-white/80 backdrop-blur px-4 py-2 rounded-lg shadow-sm border border-gray-100 text-sm text-gray-500 pointer-events-none">
        <span className="flex items-center gap-2">
            <Move className="w-4 h-4" /> Space + Drag to Pan
        </span>
      </div>

      <div 
        ref={containerRef}
        className="w-full h-full cursor-default"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <div 
          className="origin-top-left bg-dot-pattern"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            width: canvasSize.w,
            height: canvasSize.h,
          }}
        >
          {/* REMOVED: SVG Lines rendering block */}

          {/* Nodes */}
          {nodes.map(node => {
            const frame = frames[node.frameIndex];
            return (
              <div
                key={node.id}
                id={`node-card-${node.id}`}
                className="absolute bg-white rounded-3xl shadow-[0_20px_50px_rgb(0,0,0,0.1)] flex flex-col overflow-hidden border border-gray-100"
                style={{
                  left: node.x,
                  top: node.y,
                  width: 1024, // Wider width for Web Screenshots
                  height: 800, // Fixed height to prevent runaway size
                }}
              >
                {/* 1. Image Section: Fixed Height (550px) */}
                {/* object-contain ensures the FULL WIDTH of the screenshot is visible, even if it is a wide desktop page */}
                <div className="h-[550px] w-full bg-gray-50 relative border-b border-gray-100 flex-shrink-0 flex items-center justify-center">
                    <img 
                        src={frame ? frame.dataUrl : ''} 
                        className="w-full h-full object-contain object-top" 
                        alt={node.label}
                        draggable={false}
                    />
                </div>

                {/* 2. Text Section: Fixed Height (250px) */}
                {/* Ensures text area is always available and never overlapped by image */}
                <div className="h-[250px] w-full p-8 bg-white flex flex-col justify-center flex-shrink-0">
                    <div className="flex items-center justify-between mb-3">
                        <span className="bg-indigo-50 text-indigo-700 text-xs font-bold px-3 py-1.5 rounded-full uppercase tracking-wider border border-indigo-100">
                            Screen {node.level + 1}.{node.orderInLevel + 1}
                        </span>
                    </div>
                    <h3 className="text-3xl font-bold text-gray-900 leading-tight mb-3 line-clamp-1">
                        {node.label}
                    </h3>
                    <p className="text-lg text-gray-500 leading-relaxed line-clamp-3">
                        {node.description}
                    </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});