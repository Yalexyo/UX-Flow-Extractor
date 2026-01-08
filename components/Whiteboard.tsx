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

// --- Layout Algorithm (Preserved) ---
const calculateInitialLayout = (data: AnalysisResult): { nodes: LayoutNode[], width: number, height: number } => {
  // Increased width to 560px to accommodate landscape (website) screenshots safely
  // If images are portrait (360px), they will just have more breathing room.
  const nodeWidth = 560; 
  const nodeHeight = 700; 
  const gapX = 100; 
  const gapY = 120;

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
    const y = level * (nodeHeight + gapY) + 80;
    const currentRowWidth = levelWidths[level] || 0;
    const centerOffset = (maxRowWidth - currentRowWidth) / 2;
    const x = centerOffset + (order * (nodeWidth + gapX)) + 100;
    return { ...screen, level, orderInLevel: order, x, y };
  });

  return { 
    nodes, 
    width: maxRowWidth + 600, 
    height: (maxLevel + 1) * (nodeHeight + gapY) + 300 
  };
};

export const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(({ data, frames }, ref) => {
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 2000, h: 2000 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [nodeDimensions, setNodeDimensions] = useState<Record<string, { w: number, h: number, isLandscape: boolean }>>({});

  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isAltPressed, setIsAltPressed] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [interactionMode, setInteractionMode] = useState<'IDLE' | 'PANNING' | 'DRAGGING_NODE' | 'BOX_SELECTING'>('IDLE');
  const [dragStartMousePos, setDragStartMousePos] = useState({ x: 0, y: 0 });
  const [initialNodePositions, setInitialNodePositions] = useState<Record<string, {x: number, y: number}>>({});
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const [snapshotSelection, setSnapshotSelection] = useState<Set<string>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasBoundsRef = useRef<DOMRect | null>(null);
  const hasDraggedRef = useRef(false);

  // Expose export function to parent
  useImperativeHandle(ref, () => ({
    exportCards: async (onProgress) => {
        const zip = new JSZip();
        
        // Iterate through all nodes to capture them one by one
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            onProgress(i + 1, nodes.length);

            const elementId = `node-card-${node.id}`;
            const element = document.getElementById(elementId);
            
            if (element) {
                // Generate filename based on hierarchy
                const yAxis = node.level + 1;
                const xAxis = node.orderInLevel + 1;
                
                let filePrefix = `${yAxis}.${xAxis}`;
                
                // Specific override for the very first root element
                if (node.level === 0 && node.orderInLevel === 0) {
                    filePrefix = "1";
                }

                // Clean title for filename
                const safeLabel = node.label.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_'); 
                const filename = `${filePrefix}-${safeLabel}.png`;

                try {
                    const canvas = await html2canvas(element, {
                        scale: 2, 
                        backgroundColor: '#ffffff', 
                        logging: false,
                        useCORS: true,
                        // Crucial for fixing text rendering issues in export
                        onclone: (clonedDoc: Document) => {
                           const style = clonedDoc.createElement('style');
                           // Inject VERY aggressive letter-spacing for export
                           style.innerHTML = `
                             * { 
                               font-feature-settings: "liga" 0, "clig" 0, "calt" 0 !important; 
                               font-variant-ligatures: none !important;
                               font-kerning: normal !important;
                             }
                             /* Override specific elements with wider explicit pixel spacing for export */
                             h3 {
                               letter-spacing: 2.5px !important; /* Increased from 1.5px */
                             }
                             p {
                               letter-spacing: 1.2px !important; /* Increased from 0.8px */
                             }
                           `;
                           clonedDoc.head.appendChild(style);
                        },
                        ignoreElements: (element: Element) => {
                          return element.classList.contains('do-not-capture');
                        }
                    });
                    
                    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (blob) {
                        zip.file(filename, blob);
                    }
                    await new Promise(r => setTimeout(r, 50));
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
      setTransform({ x: 0, y: 0, scale: 0.8 }); 
    }
  }, [data]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') { e.preventDefault(); setIsSpacePressed(true); }
      if ((e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight')) { e.preventDefault(); setIsAltPressed(true); }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
          setIsSpacePressed(false);
          if (interactionMode === 'PANNING') setInteractionMode('IDLE');
      }
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
          setIsAltPressed(false);
          if (interactionMode === 'BOX_SELECTING' && !selectionBox) setInteractionMode('IDLE');
      }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
       if (e.altKey !== isAltPressed) {
         setIsAltPressed(e.altKey);
         if (!e.altKey && interactionMode === 'BOX_SELECTING' && !selectionBox) {
            setInteractionMode('IDLE');
         }
       }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('blur', () => {
        setIsSpacePressed(false);
        setIsAltPressed(false);
        if (interactionMode === 'PANNING') setInteractionMode('IDLE');
    });

    return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, [interactionMode, selectionBox, isAltPressed]);

  const refreshCanvasBounds = () => {
    if (containerRef.current) canvasBoundsRef.current = containerRef.current.getBoundingClientRect();
  };

  const screenToWorld = (clientX: number, clientY: number) => {
    if (!canvasBoundsRef.current) return { x: 0, y: 0 };
    return {
      x: (clientX - canvasBoundsRef.current.left - transform.x) / transform.scale,
      y: (clientY - canvasBoundsRef.current.top - transform.y) / transform.scale
    };
  };

  const isBackground = (target: EventTarget | null) => {
     if (!target) return false;
     const el = target as HTMLElement;
     return el.id === 'whiteboard-canvas' || el === containerRef.current || el.classList.contains('bg-dot-pattern');
  };

  const handleWheel = (e: React.WheelEvent) => {
    refreshCanvasBounds();
    const { clientX, clientY, deltaY } = e;
    const scaleFactor = 0.1;
    const direction = deltaY > 0 ? -1 : 1;
    const newScale = Math.min(Math.max(0.1, transform.scale + direction * scaleFactor * transform.scale), 5);
    const worldPos = screenToWorld(clientX, clientY);
    const containerX = clientX - (canvasBoundsRef.current?.left || 0);
    const containerY = clientY - (canvasBoundsRef.current?.top || 0);
    const newX = containerX - worldPos.x * newScale;
    const newY = containerY - worldPos.y * newScale;
    setTransform({ x: newX, y: newY, scale: newScale });
  };

  const zoomStep = (delta: number) => {
    setTransform(prev => {
        if (!containerRef.current) return prev;
        const rect = containerRef.current.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const worldCenterX = (centerX - prev.x) / prev.scale;
        const worldCenterY = (centerY - prev.y) / prev.scale;
        const newScale = Math.min(Math.max(0.1, prev.scale + delta), 5);
        const newX = centerX - worldCenterX * newScale;
        const newY = centerY - worldCenterY * newScale;
        return { x: newX, y: newY, scale: newScale };
    });
  };

  const resetZoom = () => { setTransform({ x: 0, y: 0, scale: 1 }); };

  const handleMouseDown = (e: React.MouseEvent) => {
    refreshCanvasBounds();
    const targetIsBackground = isBackground(e.target);
    if (isSpacePressed) {
        setInteractionMode('PANNING');
        setDragStartMousePos({ x: e.clientX, y: e.clientY });
        return;
    }
    if (isAltPressed) {
        setInteractionMode('BOX_SELECTING');
        setSelectionBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
        setSnapshotSelection(new Set(e.shiftKey ? selectedNodeIds : [])); 
        if (!e.shiftKey) setSelectedNodeIds(new Set());
        return;
    }
    if (targetIsBackground) {
        setInteractionMode('BOX_SELECTING');
        setSelectionBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
        if (!e.shiftKey) {
            setSelectedNodeIds(new Set());
            setSnapshotSelection(new Set());
        } else {
            setSnapshotSelection(new Set(selectedNodeIds));
        }
    }
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    if (isSpacePressed || isAltPressed) return;
    e.stopPropagation(); 
    refreshCanvasBounds();
    setInteractionMode('DRAGGING_NODE');
    setDragStartMousePos({ x: e.clientX, y: e.clientY });
    hasDraggedRef.current = false;

    let newSelection = new Set(selectedNodeIds);
    if (e.shiftKey) {
        if (newSelection.has(nodeId)) newSelection.delete(nodeId);
        else newSelection.add(nodeId);
    } else {
        if (!newSelection.has(nodeId)) newSelection = new Set([nodeId]);
    }
    setSelectedNodeIds(newSelection);
    
    const initials: Record<string, {x: number, y: number}> = {};
    nodes.forEach(n => {
        if (newSelection.has(n.id)) initials[n.id] = { x: n.x, y: n.y };
    });
    setInitialNodePositions(initials);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (interactionMode === 'PANNING') {
        const dx = e.clientX - dragStartMousePos.x;
        const dy = e.clientY - dragStartMousePos.y;
        setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
        setDragStartMousePos({ x: e.clientX, y: e.clientY });
    }
    else if (interactionMode === 'BOX_SELECTING' && selectionBox) {
        setSelectionBox(prev => ({ ...prev!, currentX: e.clientX, currentY: e.clientY }));
        const startWorld = screenToWorld(selectionBox.startX, selectionBox.startY);
        const currentWorld = screenToWorld(e.clientX, e.clientY);
        const boxX = Math.min(startWorld.x, currentWorld.x);
        const boxY = Math.min(startWorld.y, currentWorld.y);
        const boxW = Math.abs(currentWorld.x - startWorld.x);
        const boxH = Math.abs(currentWorld.y - startWorld.y);
        const newSelection = new Set(snapshotSelection); 
        nodes.forEach(node => {
            const dims = nodeDimensions[node.id] || { w: 360, h: 600 }; 
            const isIntersecting = boxX < node.x + dims.w && boxX + boxW > node.x && boxY < node.y + dims.h && boxY + boxH > node.y;
            if (isIntersecting) newSelection.add(node.id);
        });
        setSelectedNodeIds(newSelection);
    }
    else if (interactionMode === 'DRAGGING_NODE') {
        const screenDx = e.clientX - dragStartMousePos.x;
        const screenDy = e.clientY - dragStartMousePos.y;
        const worldDx = screenDx / transform.scale;
        const worldDy = screenDy / transform.scale;
        if (Math.abs(screenDx) > 3 || Math.abs(screenDy) > 3) hasDraggedRef.current = true;
        setNodes(prevNodes => prevNodes.map(n => {
            if (initialNodePositions[n.id]) {
                const startPos = initialNodePositions[n.id];
                return { ...n, x: startPos.x + worldDx, y: startPos.y + worldDy };
            }
            return n;
        }));
    }
  };

  const handleMouseUp = () => {
    setInteractionMode('IDLE');
    setSelectionBox(null);
  };

  const handleNodeClick = (e: React.MouseEvent, nodeId: string) => {
    if (isSpacePressed || isAltPressed) return;
    e.stopPropagation();
    if (!hasDraggedRef.current && !e.shiftKey && selectedNodeIds.has(nodeId)) {
         if (selectedNodeIds.size > 1) setSelectedNodeIds(new Set([nodeId]));
    }
  };

  const handleImageLoad = (nodeId: string, naturalWidth: number, naturalHeight: number) => {
      const ratio = naturalWidth / naturalHeight;
      const isLandscape = ratio >= 1.0;
      // Increased adaptive width to 360px minimum (standard mobile width) to prevent text squeezing
      const adaptiveWidth = isLandscape ? 560 : 360;
      // Calculate height based on image ratio
      const scaledImageHeight = adaptiveWidth / ratio;
      // Heuristic for total height: scaled Image + Header (~60px) + Padding (~40px)
      const totalCardHeight = scaledImageHeight + 110;

      setNodeDimensions(prev => ({
          ...prev,
          [nodeId]: { w: adaptiveWidth, h: totalCardHeight, isLandscape } 
      }));
  };

  const getSelectionBoxStyle = () => {
    if (!selectionBox || !containerRef.current) return {};
    const rect = containerRef.current.getBoundingClientRect();
    const left = Math.min(selectionBox.startX, selectionBox.currentX) - rect.left;
    const top = Math.min(selectionBox.startY, selectionBox.currentY) - rect.top;
    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
    const height = Math.abs(selectionBox.currentY - selectionBox.startY);
    return { left, top, width, height };
  };

  let cursorClass = 'cursor-default';
  if (isAltPressed) cursorClass = 'cursor-crosshair';
  if (interactionMode === 'BOX_SELECTING') cursorClass = 'cursor-crosshair';
  if (isSpacePressed) cursorClass = 'cursor-grab';
  if (interactionMode === 'PANNING') cursorClass = 'cursor-grabbing';

  return (
    <div className="w-full h-full relative bg-gray-100 overflow-hidden select-none font-sans">
      
      {/* Floating Panel */}
      <div className="fixed top-20 right-6 z-50 flex flex-col gap-3 animate-in slide-in-from-right-10 pointer-events-none tool-panel" data-html2canvas-ignore>
        <div className="bg-white p-2 rounded-xl shadow-lg border border-slate-200 w-48 pointer-events-auto flex items-center justify-between">
            <button onClick={() => zoomStep(-0.1)} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors" title="Zoom Out">
                <Minus className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 rounded-md cursor-pointer hover:bg-slate-100 transition-colors" onClick={resetZoom} title="Reset Zoom">
                <span className="text-xs font-mono font-medium text-slate-700 w-8 text-center">{Math.round(transform.scale * 100)}%</span>
                <RotateCcw className="w-3 h-3 text-slate-400" />
            </div>
            <button onClick={() => zoomStep(0.1)} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors" title="Zoom In">
                <Plus className="w-4 h-4" />
            </button>
        </div>
        <div className="bg-white/80 backdrop-blur p-3 rounded-xl border border-slate-200/50 shadow-sm pointer-events-auto w-48">
             <div className="text-[10px] text-slate-400 leading-tight">
                <p>• <strong>Space + Drag</strong> to Pan</p>
                <p>• <strong>Alt + Drag</strong> to Force Select</p>
                <p>• <strong>Bg Drag</strong> to Box Select</p>
            </div>
        </div>
      </div>

      <div 
        ref={containerRef}
        className={`w-full h-full overflow-hidden relative ${cursorClass}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {interactionMode === 'BOX_SELECTING' && selectionBox && (
            <div className="absolute border-2 border-purple-500 bg-purple-500/20 z-50 pointer-events-none" style={getSelectionBoxStyle()} />
        )}

        <div 
            id="whiteboard-canvas"
            className="absolute top-0 left-0 bg-slate-50 bg-dot-pattern origin-top-left will-change-transform"
            style={{ 
                width: canvasSize.w, 
                height: canvasSize.h,
                transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            }}
        >
        
        {/* Nodes */}
        {nodes.map((node) => {
           const frame = frames[node.frameIndex] ? frames[node.frameIndex] : frames[0];
           const isSelected = selectedNodeIds.has(node.id);
           const isDraggingThis = interactionMode === 'DRAGGING_NODE' && isSelected;
           
           // Adaptive Dimensions
           const dims = nodeDimensions[node.id] || { w: 360, h: 600, isLandscape: false };
           
           return (
            <div
              key={node.id}
              id={`node-card-${node.id}`} 
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              onClick={(e) => handleNodeClick(e, node.id)}
              className={`
                absolute bg-white flex flex-col transition-all duration-75 group z-10
                ${isDraggingThis ? 'shadow-2xl scale-[1.01] cursor-grabbing z-30' : 'hover:shadow-lg cursor-grab'}
                ${isSelected ? 'ring-4 ring-indigo-500/20 shadow-xl' : 'shadow-sm border border-slate-200'}
                ${(isSpacePressed || isAltPressed) ? 'pointer-events-none' : ''}
              `}
              style={{
                left: node.x,
                top: node.y,
                width: `${dims.w}px`,
                height: 'auto',
                minHeight: '200px',
                borderRadius: '16px', // Standard modern radius
                padding: '20px', // Standard internal padding
                willChange: isDraggingThis ? 'left, top' : 'auto' 
              }}
            >
              {/* Header: Clean Typography with VERY WIDE tracking */}
              <div className="flex flex-col mb-3 select-none">
                 <h3 className="font-bold text-slate-900 text-lg leading-normal mb-2 tracking-widest break-words" title={node.label}>{node.label}</h3>
                 <p className="text-xs text-slate-500 leading-relaxed font-medium tracking-wider break-words" title={node.description}>{node.description}</p>
              </div>

              {/* Image Container: Pseudo-Device Frame */}
              <div className="flex-1 relative flex flex-col pointer-events-none">
                <div className="rounded-xl border-[1px] border-slate-100 overflow-hidden shadow-sm relative bg-slate-50">
                    {frame ? (
                        <img 
                            src={frame.dataUrl} 
                            alt={node.label} 
                            className="w-full h-auto object-contain block" 
                            draggable={false} 
                            onLoad={(e) => handleImageLoad(node.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                        /> 
                    ) : (
                        <div className="w-full h-40 flex flex-col items-center justify-center text-slate-300 gap-2"><span className="text-xs">No Preview</span></div>
                    )}
                </div>
              </div>

              {/* Selection Indicator (Overlay Only) */}
              {isSelected && (
                  <div className="absolute inset-0 rounded-2xl border-2 border-indigo-500 pointer-events-none do-not-capture"></div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
});