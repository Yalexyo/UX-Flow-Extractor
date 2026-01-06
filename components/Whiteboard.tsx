import React, { useState, useEffect, useRef } from 'react';
import { AnalysisResult, FrameData, FlowEdge } from '../types';
import { Settings2, Move, Trash2, Plus, Minus, RotateCcw } from 'lucide-react';

interface WhiteboardProps {
  data: AnalysisResult;
  frames: FrameData[];
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

// Extend FlowEdge to support visual offsets for custom anchor positions
interface VisualEdge extends FlowEdge {
  fromOffset?: { x: number, y: number };
  toOffset?: { x: number, y: number };
}

// --- Layout Algorithm ---
const calculateInitialLayout = (data: AnalysisResult): { nodes: LayoutNode[], width: number, height: number } => {
  const nodeWidth = 240; 
  const nodeHeight = 460;
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
    width: maxRowWidth + 400, 
    height: (maxLevel + 1) * (nodeHeight + gapY) + 300 
  };
};

const getEdgePath = (startX: number, startY: number, endX: number, endY: number) => {
  const isBackwards = endY < startY + 20;
  const radius = 12;

  // Path Style: Rounded Orthogonal (Manhattan with fillets)
  
  if (isBackwards) {
    // Loop Style (Down -> Out -> Up -> In -> Down)
    // We calculate "Turn X" to be to the right of the rightmost point
    const loopOffset = 180;
    const turnX = Math.max(startX, endX) + loopOffset;
    const topY = endY - 60;
    const bottomY = startY + 40;

    // To prevent radius artifacts on short segments, clamp radius
    const r = Math.min(radius, Math.abs(turnX - startX) / 2, Math.abs(bottomY - startY) / 2);
    
    // Direction multipliers for arc sweeps
    const startDir = turnX > startX ? 1 : -1;
    const endDir = turnX > endX ? 1 : -1;

    // Segment 1: Down from Start
    // Segment 2: Horizontal to TurnX
    // Segment 3: Up to TopY
    // Segment 4: Horizontal to EndX
    // Segment 5: Down to EndY

    return `M ${startX} ${startY}
            L ${startX} ${bottomY - r}
            Q ${startX} ${bottomY} ${startX + r * startDir} ${bottomY}
            L ${turnX - r * startDir} ${bottomY}
            Q ${turnX} ${bottomY} ${turnX} ${bottomY - r}
            L ${turnX} ${topY + r}
            Q ${turnX} ${topY} ${turnX - r * endDir} ${topY}
            L ${endX + r * endDir} ${topY}
            Q ${endX} ${topY} ${endX} ${topY + r}
            L ${endX} ${endY}`;
  } else {
    // Standard Step Style (Down -> Across -> Down)
    // Works for custom anchors too, finding a mid-Y point
    
    // If points are vertically very close, just draw straight line to avoid weird S-curves
    if (Math.abs(endY - startY) < radius * 2) {
       return `M ${startX} ${startY} L ${endX} ${endY}`;
    }

    const midY = (startY + endY) / 2;
    const r = Math.min(radius, Math.abs(midY - startY) / 2, Math.abs(endX - startX) / 2);
    
    const xDir = endX > startX ? 1 : -1;

    // Vertical down to mid, Turn, Horizontal, Turn, Vertical down
    if (Math.abs(endX - startX) < 2) {
        // Strictly vertical
        return `M ${startX} ${startY} L ${endX} ${endY}`;
    }

    return `M ${startX} ${startY}
            L ${startX} ${midY - r}
            Q ${startX} ${midY} ${startX + r * xDir} ${midY}
            L ${endX - r * xDir} ${midY}
            Q ${endX} ${midY} ${endX} ${midY + r}
            L ${endX} ${endY}`;
  }
};

const getLabelPosition = (startX: number, startY: number, endX: number, endY: number) => {
  const isBackwards = endY < startY + 20;

  if (isBackwards) {
    const loopOffset = 180;
    const turnX = Math.max(startX, endX) + loopOffset;
    // Place label on the long vertical segment going up
    const topY = endY - 60;
    const bottomY = startY + 40;
    return { x: turnX, y: (topY + bottomY) / 2 };
  }

  // Standard step: Place label on the horizontal segment
  const midY = (startY + endY) / 2;
  return { x: (startX + endX) / 2, y: midY };
};

export const Whiteboard: React.FC<WhiteboardProps> = ({ data, frames }) => {
  // --- State ---
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [edges, setEdges] = useState<VisualEdge[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 2000, h: 2000 });
  const [edgeStyle, setEdgeStyle] = useState({ width: 2 });
  
  // Transform State (Zoom & Pan)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });

  // Tool / Modifier State
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isAltPressed, setIsAltPressed] = useState(false);

  // Selection & Edit State
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeIndex, setSelectedEdgeIndex] = useState<number | null>(null);
  const [editingEdge, setEditingEdge] = useState<{ index: number, text: string } | null>(null);
  
  // Interaction Mode State
  const [interactionMode, setInteractionMode] = useState<'IDLE' | 'PANNING' | 'DRAGGING_NODE' | 'RECONNECTING' | 'BOX_SELECTING'>('IDLE');

  const [dragStartMousePos, setDragStartMousePos] = useState({ x: 0, y: 0 }); // Screen coords for Panning/Dragging
  const [initialNodePositions, setInitialNodePositions] = useState<Record<string, {x: number, y: number}>>({});
  
  // Box Selection State
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const [snapshotSelection, setSnapshotSelection] = useState<Set<string>>(new Set());

  const [reconnectingEdge, setReconnectingEdge] = useState<{ index: number, handle: 'from' | 'to', startX: number, startY: number } | null>(null);
  const [snapCandidateId, setSnapCandidateId] = useState<string | null>(null);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasBoundsRef = useRef<DOMRect | null>(null);
  const mousePosRef = useRef({ x: 0, y: 0 }); // World Coordinates
  const hasDraggedRef = useRef(false);

  // --- Initialization ---
  useEffect(() => {
    if (data && data.screens.length > 0) {
      const layout = calculateInitialLayout(data);
      setNodes(layout.nodes);
      // Initialize edges without custom offsets
      setEdges(data.edges.map(e => ({ ...e })));
      
      setCanvasSize({ 
        w: Math.max(layout.width + 1000, 3000), 
        h: Math.max(layout.height + 1000, 3000) 
      });
      
      const screenW = window.innerWidth;
      const startX = Math.max(0, (screenW - layout.width) / 2);
      setTransform({ x: 0, y: 0, scale: 0.8 }); 
    }
  }, [data]);

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdgeIndex !== null) {
          e.preventDefault(); 
          setEdges(prev => prev.filter((_, idx) => idx !== selectedEdgeIndex));
          setSelectedEdgeIndex(null);
        }
      }

      // Spacebar Logic
      if (e.key === ' ' && !e.repeat) {
          e.preventDefault();
          setIsSpacePressed(true);
      }

      // Alt/Option Logic (Checking both key and code for robustness)
      if ((e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') && !e.repeat) {
          e.preventDefault();
          setIsAltPressed(true);
      }
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

    // Global Mouse Move for robust sync
    const handleGlobalMouseMove = (e: MouseEvent) => {
       // If Alt key state mismatches our react state, sync it
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
        window.removeEventListener('blur', () => {});
    };
  }, [selectedEdgeIndex, interactionMode, selectionBox, isAltPressed]);

  // --- Coordinate Systems ---

  const refreshCanvasBounds = () => {
    if (containerRef.current) {
      canvasBoundsRef.current = containerRef.current.getBoundingClientRect();
    }
  };

  const screenToWorld = (clientX: number, clientY: number) => {
    if (!canvasBoundsRef.current) return { x: 0, y: 0 };
    return {
      x: (clientX - canvasBoundsRef.current.left - transform.x) / transform.scale,
      y: (clientY - canvasBoundsRef.current.top - transform.y) / transform.scale
    };
  };

  const updateMousePosRef = (e: React.MouseEvent) => {
    const worldPos = screenToWorld(e.clientX, e.clientY);
    mousePosRef.current = worldPos;
    return worldPos;
  };

  const isBackground = (target: EventTarget | null) => {
     if (!target) return false;
     const el = target as HTMLElement;
     return el.id === 'whiteboard-canvas' || el === containerRef.current || el.classList.contains('bg-dot-pattern');
  };

  // --- Zoom Logic ---

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

    setTransform({
      x: newX,
      y: newY,
      scale: newScale
    });
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

  const resetZoom = () => {
      setTransform({ x: 0, y: 0, scale: 1 });
  };

  // --- Interaction Handlers ---

  const handleMouseDown = (e: React.MouseEvent) => {
    refreshCanvasBounds();
    const targetIsBackground = isBackground(e.target);
    
    // Priority 1: Spacebar Pan (Overrides everything)
    if (isSpacePressed) {
        setInteractionMode('PANNING');
        setDragStartMousePos({ x: e.clientX, y: e.clientY });
        return;
    }

    // Priority 2: Alt Key Box Selection (Overrides everything, forces selection even over nodes)
    if (isAltPressed) {
        setInteractionMode('BOX_SELECTING');
        setSelectionBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
        // If Shift is held with Alt, we add to selection, otherwise reset
        setSnapshotSelection(new Set(e.shiftKey ? selectedNodeIds : [])); 
        if (!e.shiftKey) setSelectedNodeIds(new Set());
        return;
    }

    // Priority 3: Default Behavior
    // If clicking background -> Box Select (Standard for Design Tools)
    if (targetIsBackground) {
        setInteractionMode('BOX_SELECTING');
        setSelectionBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
        
        // Clicking background clears selection unless Shift is held
        if (!e.shiftKey) {
            setSelectedNodeIds(new Set());
            setSnapshotSelection(new Set());
            // ALSO Clear Edge Selection
            setSelectedEdgeIndex(null);
            setEditingEdge(null);
        } else {
            setSnapshotSelection(new Set(selectedNodeIds));
        }
    }
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    // If Space or Alt is pressed, prevent the default node drag logic
    // We do NOT call stopPropagation so the event bubbles to the container to handle Pan/BoxSelect
    if (isSpacePressed || isAltPressed) return;

    // Normal Node Dragging behavior
    e.stopPropagation(); 
    refreshCanvasBounds();
    
    setInteractionMode('DRAGGING_NODE');
    setDragStartMousePos({ x: e.clientX, y: e.clientY });
    hasDraggedRef.current = false;

    // Select Logic
    let newSelection = new Set(selectedNodeIds);
    if (e.shiftKey) {
        if (newSelection.has(nodeId)) newSelection.delete(nodeId);
        else newSelection.add(nodeId);
    } else {
        if (!newSelection.has(nodeId)) newSelection = new Set([nodeId]);
    }

    setSelectedNodeIds(newSelection);
    setSelectedEdgeIndex(null);
    setEditingEdge(null);

    // Prepare Drag
    const initials: Record<string, {x: number, y: number}> = {};
    nodes.forEach(n => {
        if (newSelection.has(n.id)) {
            initials[n.id] = { x: n.x, y: n.y };
        }
    });
    setInitialNodePositions(initials);
  };

  const startReconnecting = (e: React.MouseEvent, index: number, handle: 'from' | 'to', startX: number, startY: number) => {
    if (isSpacePressed || isAltPressed) return;
    
    e.stopPropagation();
    e.preventDefault();
    refreshCanvasBounds();
    updateMousePosRef(e);
    
    setInteractionMode('RECONNECTING');
    setReconnectingEdge({ index, handle, startX, startY });
    setEditingEdge(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    updateMousePosRef(e); 

    if (interactionMode === 'PANNING') {
        const dx = e.clientX - dragStartMousePos.x;
        const dy = e.clientY - dragStartMousePos.y;
        
        setTransform(prev => ({
            ...prev,
            x: prev.x + dx,
            y: prev.y + dy
        }));
        setDragStartMousePos({ x: e.clientX, y: e.clientY });
    }
    else if (interactionMode === 'BOX_SELECTING' && selectionBox) {
        // Update visual box coordinates
        setSelectionBox(prev => ({ ...prev!, currentX: e.clientX, currentY: e.clientY }));

        // Calculate intersection in World Space
        const startWorld = screenToWorld(selectionBox.startX, selectionBox.startY);
        const currentWorld = screenToWorld(e.clientX, e.clientY);

        // Define Box Rect in World Coords
        const boxX = Math.min(startWorld.x, currentWorld.x);
        const boxY = Math.min(startWorld.y, currentWorld.y);
        const boxW = Math.abs(currentWorld.x - startWorld.x);
        const boxH = Math.abs(currentWorld.y - startWorld.y);

        const newSelection = new Set(snapshotSelection); 
        
        nodes.forEach(node => {
            // Node Rect in World Coords (Fixed size)
            const nodeW = 240;
            const nodeH = 460;
            
            const isIntersecting = 
                boxX < node.x + nodeW &&
                boxX + boxW > node.x &&
                boxY < node.y + nodeH &&
                boxY + boxH > node.y;

            if (isIntersecting) {
                newSelection.add(node.id);
            }
        });

        setSelectedNodeIds(newSelection);
    }
    else if (interactionMode === 'DRAGGING_NODE') {
        const screenDx = e.clientX - dragStartMousePos.x;
        const screenDy = e.clientY - dragStartMousePos.y;
        
        const worldDx = screenDx / transform.scale;
        const worldDy = screenDy / transform.scale;

        if (Math.abs(screenDx) > 3 || Math.abs(screenDy) > 3) {
            hasDraggedRef.current = true;
        }

        setNodes(prevNodes => prevNodes.map(n => {
            if (initialNodePositions[n.id]) {
                const startPos = initialNodePositions[n.id];
                return { 
                    ...n, 
                    x: startPos.x + worldDx, 
                    y: startPos.y + worldDy
                };
            }
            return n;
        }));
    }
    else if (interactionMode === 'RECONNECTING' && reconnectingEdge) {
        const mouseWorld = mousePosRef.current;
        const hitNode = nodes.find(n => {
            return mouseWorld.x >= n.x && mouseWorld.x <= n.x + 240 &&
                   mouseWorld.y >= n.y && mouseWorld.y <= n.y + 460;
        });
        
        if (hitNode?.id !== snapCandidateId) {
            setSnapCandidateId(hitNode ? hitNode.id : null);
        }
        setReconnectingEdge(prev => prev ? { ...prev } : null);
    }
  };

  const handleMouseUp = () => {
    if (interactionMode === 'RECONNECTING' && reconnectingEdge && snapCandidateId) {
        setEdges(prev => prev.map((e, idx) => {
          if (idx === reconnectingEdge.index) {
            const updatedEdge = { ...e };
            const targetNode = nodes.find(n => n.id === snapCandidateId);
            const mousePos = mousePosRef.current;

            if (targetNode) {
                // Calculate relative position within the node (0-240, 0-460)
                const relativeX = Math.min(Math.max(0, mousePos.x - targetNode.x), 240);
                const relativeY = Math.min(Math.max(0, mousePos.y - targetNode.y), 460);
                
                if (reconnectingEdge.handle === 'from') {
                    updatedEdge.fromId = snapCandidateId;
                    updatedEdge.fromOffset = { x: relativeX, y: relativeY };
                } else {
                    updatedEdge.toId = snapCandidateId;
                    updatedEdge.toOffset = { x: relativeX, y: relativeY };
                }
            }
            return updatedEdge;
          }
          return e;
        }));
    }

    setInteractionMode('IDLE');
    setSelectionBox(null);
    setReconnectingEdge(null);
    setSnapCandidateId(null);
  };

  const handleNodeClick = (e: React.MouseEvent, nodeId: string) => {
    if (isSpacePressed || isAltPressed) return;
    
    e.stopPropagation();
    // If we clicked a node that was part of a group selection, but we didn't drag,
    // we probably meant to select JUST that node (unless Shift is held).
    if (!hasDraggedRef.current && !e.shiftKey && selectedNodeIds.has(nodeId)) {
         if (selectedNodeIds.size > 1) {
             setSelectedNodeIds(new Set([nodeId]));
         }
    }
  };

  const handleLabelDoubleClick = (e: React.MouseEvent, index: number, currentText: string) => {
    e.stopPropagation();
    setEditingEdge({ index, text: currentText });
    setSelectedEdgeIndex(index);
  };

  const commitLabelEdit = () => {
    if (editingEdge) {
        setEdges(prev => prev.map((edge, i) => 
            i === editingEdge.index ? { ...edge, label: editingEdge.text } : edge
        ));
        setEditingEdge(null);
    }
  };

  const getSelectionBoxStyle = () => {
    if (!selectionBox || !containerRef.current) return {};
    const rect = containerRef.current.getBoundingClientRect();
    
    // We need to render the box in screen coordinates relative to the container div
    const left = Math.min(selectionBox.startX, selectionBox.currentX) - rect.left;
    const top = Math.min(selectionBox.startY, selectionBox.currentY) - rect.top;
    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
    const height = Math.abs(selectionBox.currentY - selectionBox.startY);

    return { left, top, width, height };
  };

  const PRIMARY_COLOR = "#4F47E6";

  // Determine cursor style based on priority
  let cursorClass = 'cursor-default';
  
  // 1. Base Alt/Option state (Box Select) - Lowest operational priority, but visual cue
  if (isAltPressed) cursorClass = 'cursor-crosshair';
  if (interactionMode === 'BOX_SELECTING') cursorClass = 'cursor-crosshair';
  
  // 2. Space/Pan - Overrides Alt
  if (isSpacePressed) cursorClass = 'cursor-grab';
  if (interactionMode === 'PANNING') cursorClass = 'cursor-grabbing';
  
  // 3. Reconnecting (Specific interaction) - Highest Priority
  if (interactionMode === 'RECONNECTING') cursorClass = 'cursor-crosshair';

  return (
    <div className="w-full h-full relative bg-gray-100 overflow-hidden select-none">
      
      {/* Floating Panel: Settings & Zoom */}
      <div 
        className="fixed top-20 right-6 z-50 flex flex-col gap-3 animate-in slide-in-from-right-10 pointer-events-none tool-panel"
        data-html2canvas-ignore
      >
        {/* Panel 1: Settings */}
        <div className="bg-white p-3 rounded-xl shadow-lg border border-slate-200 w-48 pointer-events-auto">
            <div className="flex items-center gap-2 text-slate-700 pb-2 border-b border-slate-100">
            <Settings2 className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider">Edge Styles</span>
            </div>
            
            <div className="space-y-1 mt-2">
            <label className="text-[10px] text-slate-500 font-medium flex justify-between">
                <span>Thickness</span>
                <span>{edgeStyle.width}px</span>
            </label>
            <input 
                type="range" 
                min="1" 
                max="8" 
                step="1"
                value={edgeStyle.width}
                onChange={(e) => setEdgeStyle({ ...edgeStyle, width: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
            />
            </div>
            
            {selectedEdgeIndex !== null && (
                <button 
                    onClick={() => {
                        if (selectedEdgeIndex !== null) {
                            setEdges(prev => prev.filter((_, idx) => idx !== selectedEdgeIndex));
                            setSelectedEdgeIndex(null);
                            setEditingEdge(null);
                        }
                    }}
                    className="mt-2 w-full flex items-center justify-center gap-2 bg-red-50 text-red-600 hover:bg-red-100 p-2 rounded-lg text-[11px] font-bold transition-colors border border-red-100 cursor-pointer"
                >
                    <Trash2 className="w-3 h-3" />
                    Delete Connection
                </button>
            )}
        </div>

        {/* Panel 2: Zoom Controls */}
        <div className="bg-white p-2 rounded-xl shadow-lg border border-slate-200 w-48 pointer-events-auto flex items-center justify-between">
            <button 
                onClick={() => zoomStep(-0.1)} 
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors"
                title="Zoom Out"
            >
                <Minus className="w-4 h-4" />
            </button>
            
            <div 
                className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 rounded-md cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={resetZoom}
                title="Reset Zoom"
            >
                <span className="text-xs font-mono font-medium text-slate-700 w-8 text-center">
                    {Math.round(transform.scale * 100)}%
                </span>
                <RotateCcw className="w-3 h-3 text-slate-400" />
            </div>

            <button 
                onClick={() => zoomStep(0.1)} 
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors"
                title="Zoom In"
            >
                <Plus className="w-4 h-4" />
            </button>
        </div>

        {/* Instructions */}
        <div className="bg-white/80 backdrop-blur p-3 rounded-xl border border-slate-200/50 shadow-sm pointer-events-auto">
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
        {/* Selection Box Overlay (Fixed z-index, renders on top) */}
        {interactionMode === 'BOX_SELECTING' && selectionBox && (
            <div 
                className="absolute border-2 border-purple-500 bg-purple-500/20 z-50 pointer-events-none"
                style={getSelectionBoxStyle()}
            />
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
        
        {/* Edges Layer (SVG) */}
        <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-20">
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill={PRIMARY_COLOR} />
            </marker>
            <marker id="arrowhead-selected" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill="#f43f5e" />
            </marker>
          </defs>

          {edges.map((edge, idx) => {
            const isSelected = selectedEdgeIndex === idx;
            const isReconnecting = reconnectingEdge?.index === idx;
            
            if (isReconnecting) {
              const staticNodeId = reconnectingEdge.handle === 'from' ? edge.toId : edge.fromId;
              const staticNode = nodes.find(n => n.id === staticNodeId);
              if (!staticNode) return null;

              // Use stored offset for static node, or default
              const sOffset = reconnectingEdge.handle === 'from' 
                ? (edge.toOffset || {x: 120, y: 2})
                : (edge.fromOffset || {x: 120, y: 458});

              const sX = staticNode.x + sOffset.x;
              const sY = staticNode.y + sOffset.y;
              
              let dX = mousePosRef.current.x; // World Coords
              let dY = mousePosRef.current.y;

              if (snapCandidateId) {
                  const snapNode = nodes.find(n => n.id === snapCandidateId);
                  if (snapNode) {
                      // Calculate dynamic snap position based on mouse over snap target
                      const relX = Math.min(Math.max(0, mousePosRef.current.x - snapNode.x), 240);
                      const relY = Math.min(Math.max(0, mousePosRef.current.y - snapNode.y), 460);
                      dX = snapNode.x + relX;
                      dY = snapNode.y + relY;
                  }
              }

              const path = reconnectingEdge.handle === 'from' 
                ? getEdgePath(dX, dY, sX, sY) 
                : getEdgePath(sX, sY, dX, dY);

              return (
                <g key={`temp-${idx}`}>
                    <path d={path} stroke="#cbd5e1" strokeWidth={edgeStyle.width} strokeDasharray="5,5" fill="none" />
                    {/* Reconnecting Handle */}
                    <circle cx={dX} cy={dY} r="6" fill="#f43f5e" opacity="0.8" />
                </g>
              );
            }

            const fromNode = nodes.find(n => n.id === edge.fromId);
            const toNode = nodes.find(n => n.id === edge.toId);
            if (!fromNode || !toNode) return null;

            const fromOff = edge.fromOffset || { x: 120, y: 458 };
            const toOff = edge.toOffset || { x: 120, y: 2 };

            const startX = fromNode.x + fromOff.x;
            const startY = fromNode.y + fromOff.y; 
            const endX = toNode.x + toOff.x;
            const endY = toNode.y + toOff.y;      
            
            const dPath = getEdgePath(startX, startY, endX, endY);
            
            return (
              <g key={`${edge.fromId}-${edge.toId}-${idx}`} className="group/edge pointer-events-auto">
                <path
                  d={dPath} stroke="transparent" strokeWidth="24" fill="none" className="cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); setSelectedEdgeIndex(idx); }}
                />
                <path
                  d={dPath}
                  stroke={isSelected ? "#f43f5e" : PRIMARY_COLOR}
                  strokeWidth={isSelected ? edgeStyle.width + 1 : edgeStyle.width}
                  fill="none"
                  markerEnd={`url(#${isSelected ? 'arrowhead-selected' : 'arrowhead'})`}
                  className="transition-colors duration-200 pointer-events-none"
                />
                
                {/* Permanent Anchor Dot - Visible at Start of Edge */}
                {!isSelected && (
                    <circle 
                        cx={startX} 
                        cy={startY} 
                        r="5" 
                        fill="#4F47E6" 
                        stroke="white" 
                        strokeWidth="2" 
                        className="pointer-events-auto cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setSelectedEdgeIndex(idx); }}
                    />
                )}

                {/* Interactive Handles (Drag to Reconnect) - Only when selected */}
                {isSelected && !editingEdge && (
                  <>
                     <circle cx={startX} cy={startY} r="7" fill="#f43f5e" stroke="white" strokeWidth="2" className="cursor-move pointer-events-auto hover:scale-110"
                        onMouseDown={(e) => startReconnecting(e, idx, 'from', startX, startY)} />
                     <circle cx={endX} cy={endY} r="7" fill="#f43f5e" stroke="white" strokeWidth="2" className="cursor-move pointer-events-auto hover:scale-110"
                        onMouseDown={(e) => startReconnecting(e, idx, 'to', endX, endY)} />
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {/* Labels Layer (HTML Divs for better Export Support) */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-40">
           {edges.map((edge, idx) => {
              if (reconnectingEdge?.index === idx) return null;

              const fromNode = nodes.find(n => n.id === edge.fromId);
              const toNode = nodes.find(n => n.id === edge.toId);
              if (!fromNode || !toNode) return null;

              const fromOff = edge.fromOffset || { x: 120, y: 458 };
              const toOff = edge.toOffset || { x: 120, y: 2 };

              const startX = fromNode.x + fromOff.x;
              const startY = fromNode.y + fromOff.y; 
              const endX = toNode.x + toOff.x;
              const endY = toNode.y + toOff.y;

              const labelPos = getLabelPosition(startX, startY, endX, endY);
              const isSelected = selectedEdgeIndex === idx;
              const isEditing = editingEdge?.index === idx;

              return (
                 <div 
                    key={`label-${idx}`}
                    className="absolute pointer-events-auto flex justify-center items-center"
                    style={{
                        left: labelPos.x - 80, 
                        top: labelPos.y - 15, 
                        width: 160, 
                        height: 30,
                    }}
                 >
                    {isEditing ? (
                        <input 
                            type="text" value={editingEdge.text}
                            onChange={(e) => setEditingEdge({ ...editingEdge, text: e.target.value })}
                            onBlur={commitLabelEdit}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitLabelEdit();
                                if (e.key === 'Escape') setEditingEdge(null);
                                e.stopPropagation();
                            }}
                            autoFocus
                            className="pointer-events-auto bg-white border-2 border-indigo-500 text-xs text-indigo-800 px-2 py-1 rounded shadow-lg outline-none text-center w-full min-w-[100px]"
                        />
                    ) : (
                        <span 
                            onDoubleClick={(e) => handleLabelDoubleClick(e, idx, edge.label)}
                            onClick={(e) => { e.stopPropagation(); setSelectedEdgeIndex(idx); }}
                            className={`pointer-events-auto cursor-text bg-white border font-medium text-[10px] px-2 py-1 rounded-full shadow-sm whitespace-nowrap transition-all select-none hover:scale-105 active:scale-95
                                ${isSelected ? 'border-rose-200 text-rose-600 ring-2 ring-rose-50' : 'border-indigo-100 text-indigo-700'}`}
                        >
                        {edge.label}
                        </span>
                    )}
                 </div>
              )
           })}
        </div>

        {/* Nodes Layer */}
        {nodes.map((node) => {
           const frame = frames[node.frameIndex] ? frames[node.frameIndex] : frames[0];
           const isSelected = selectedNodeIds.has(node.id);
           const isDraggingThis = interactionMode === 'DRAGGING_NODE' && isSelected;
           const isSnapTarget = snapCandidateId === node.id;
           
           return (
            <div
              key={node.id}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              onClick={(e) => handleNodeClick(e, node.id)}
              className={`
                absolute bg-white rounded-2xl flex flex-col transition-all duration-75 group z-10
                ${isDraggingThis ? 'shadow-2xl scale-[1.01] cursor-grabbing z-30' : 'hover:shadow-lg cursor-grab'}
                ${isSelected ? 'border-2 border-indigo-500 ring-4 ring-indigo-500/10 shadow-xl' : 'border border-slate-200 shadow-sm'}
                ${isSnapTarget ? 'ring-4 ring-rose-400/50 border-rose-400' : ''}
                ${(isSpacePressed || isAltPressed) ? 'pointer-events-none' : ''}
              `}
              style={{
                left: node.x,
                top: node.y,
                width: '240px',
                height: '460px',
                willChange: isDraggingThis ? 'left, top' : 'auto' 
              }}
            >
              <div className={`p-4 border-b flex-shrink-0 select-none rounded-t-xl ${isSelected ? 'bg-indigo-50/50 border-indigo-100' : 'bg-white border-slate-100'}`}>
                <div className="flex justify-between items-start mb-2">
                   <h3 className="font-bold text-slate-800 text-sm leading-6 line-clamp-2 pr-2" title={node.label}>{node.label}</h3>
                  <div className="flex items-center gap-1 flex-shrink-0">
                     {isSelected && <Move className="w-3 h-3 text-indigo-500" />}
                     <span className={`text-[9px] font-mono px-1 rounded ${isSelected ? 'text-indigo-500 bg-indigo-100' : 'text-slate-300 bg-slate-50'}`}>#{node.id}</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 leading-5 line-clamp-3" title={node.description}>{node.description}</p>
              </div>

              <div className="flex-1 p-3 bg-slate-50 rounded-b-2xl relative flex flex-col pointer-events-none">
                <div className="flex-1 bg-white rounded-lg border border-slate-200 overflow-hidden shadow-inner relative">
                    {frame ? <img src={frame.dataUrl} alt={node.label} className="w-full h-full object-contain" draggable={false} /> 
                          : <div className="w-full h-full flex flex-col items-center justify-center text-slate-300 gap-2"><span className="text-[10px]">No Preview</span></div>}
                </div>
              </div>
              <div className={`absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white pointer-events-none ${isSelected || isSnapTarget ? 'bg-indigo-500' : 'bg-slate-200'}`}></div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};