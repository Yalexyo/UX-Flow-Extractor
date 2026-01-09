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
  // Layout Constraints per user request
  const nodeWidth = 1024; 
  const nodeHeight = 800; 
  const gapX = 5; // Reduced gap to 5px
  const gapY = 5; // Reduced gap to 5px
  const maxColumns = 5; // Max 5 cards per row

  // 1. Sort screens strictly by frameIndex to ensure chronological order (Time-based)
  // This ensures the visual flow matches the video timeline exactly.
  const sortedScreens = [...data.screens].sort((a, b) => a.frameIndex - b.frameIndex);

  // 2. Grid Layout Calculation
  const nodes = sortedScreens.map((screen, index) => {
    // Calculate Grid Position (0-based)
    const col = index % maxColumns;
    const row = Math.floor(index / maxColumns);

    // Calculate Pixel Position
    // Adding 100px initial padding
    const x = 100 + col * (nodeWidth + gapX);
    const y = 100 + row * (nodeHeight + gapY);

    return { 
      ...screen, 
      level: row,         // Reuse 'level' as Row index
      orderInLevel: col,  // Reuse 'orderInLevel' as Column index
      x, 
      y 
    };
  });

  // 3. Calculate Canvas Dimensions
  const numRows = Math.ceil(sortedScreens.length / maxColumns);
  const numCols = Math.min(sortedScreens.length, maxColumns);

  const width = 100 + numCols * (nodeWidth + gapX) + 100;
  const height = 100 + numRows * (nodeHeight + gapY) + 100;

  return { nodes, width, height };
};

export const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(({ data, frames }, ref) => {
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 2000, h: 2000 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 0.25 }); // Start zoomed out more to see the grid
  
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'IDLE' | 'PANNING'>('IDLE');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  
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
                // STRATEGY: Clone the element and append to body at (0,0) with no transform.
                // This isolates the capture from the current zoom/pan state of the Whiteboard.
                // It ensures high resolution and prevents text visibility issues caused by off-screen rendering.
                const clone = element.cloneNode(true) as HTMLElement;
                
                // Reset styling to ensure it's captured in its "ideal" state
                clone.style.position = 'fixed';
                clone.style.top = '0';
                clone.style.left = '0';
                clone.style.zIndex = '-9999'; // Hide behind everything
                clone.style.transform = 'none'; // Remove any scaling
                clone.style.margin = '0';
                clone.style.width = '1024px'; // Force correct dimensions
                clone.style.height = '800px';
                clone.style.boxShadow = 'none'; // Optional: remove shadow for cleaner cut
                
                // Remove selection rings/borders from export
                clone.classList.remove('ring-4', 'ring-indigo-500', 'ring-offset-4');
                
                // --- EXPORT FIX: Image Stretching ---
                // html2canvas often fails to render object-fit: contain correctly.
                // We must manually calculate the aspect ratio and set exact width/height on the img element.
                const img = clone.querySelector('img') as HTMLImageElement;
                const originalImg = element.querySelector('img') as HTMLImageElement;

                if (img && originalImg && originalImg.naturalWidth) {
                    const natW = originalImg.naturalWidth;
                    const natH = originalImg.naturalHeight;
                    // The container size in the card
                    const containerW = 1024;
                    const containerH = 550;

                    const scale = Math.min(containerW / natW, containerH / natH);
                    const finalW = Math.floor(natW * scale);
                    const finalH = Math.floor(natH * scale);

                    // Reset classes that force full width/height
                    img.classList.remove('w-full', 'h-full', 'object-contain', 'object-top');
                    
                    // Apply calculated dimensions
                    img.style.width = `${finalW}px`;
                    img.style.height = `${finalH}px`;
                    
                    // Emulate object-position: top center
                    img.style.display = 'block';
                    img.style.marginLeft = 'auto';
                    img.style.marginRight = 'auto';
                    img.style.marginTop = '0'; 
                    
                    // Ensure parent doesn't force vertical centering if we want top alignment
                    const imgParent = img.parentElement;
                    if (imgParent) {
                        imgParent.classList.remove('items-center', 'justify-center');
                        imgParent.classList.add('items-start'); 
                    }
                }

                // --- EXPORT FIX: Text Layout Adjustments ---
                // The text container is usually the last child (Image div is first, Text div is second)
                const textContainer = clone.lastElementChild as HTMLElement;
                if (textContainer) {
                    // Switch to block layout to avoid flexbox vertical-centering clipping issues in html2canvas
                    textContainer.style.display = 'block';
                    // Add padding to visually simulate the original centered layout without relying on flex center
                    textContainer.style.paddingTop = '40px'; 
                    textContainer.style.paddingLeft = '32px'; 
                    textContainer.style.paddingRight = '32px'; 
                    
                    // Allow container to fit content, prevent hard clipping
                    textContainer.style.overflow = 'visible'; 
                }

                const clamped = clone.querySelectorAll('.line-clamp-1, .line-clamp-3');
                clamped.forEach(el => {
                   el.classList.remove('line-clamp-1', 'line-clamp-3');
                   const hEl = el as HTMLElement;
                   
                   // CRITICAL FIXES FOR TEXT CLIPPING:
                   // 1. Force block display and visible overflow to allow descenders (g, y, p) to show
                   hEl.style.display = 'block';
                   hEl.style.overflow = 'visible'; 
                   hEl.style.textOverflow = 'clip'; // Remove ellipses
                   
                   // 2. Allow text to wrap naturally so it isn't cut off horizontally
                   hEl.style.whiteSpace = 'normal'; 
                   
                   // 3. Unrestrict height so it fits all text
                   hEl.style.height = 'auto'; 
                   hEl.style.maxHeight = 'none';

                   // 4. Set a generous line-height to prevent vertical clipping
                   hEl.style.lineHeight = '1.4';
                   
                   // Minor tweak for title spacing since we removed flex gap
                   if (el.tagName === 'H3') {
                     hEl.style.marginBottom = '12px';
                   }
                });

                document.body.appendChild(clone);

                // Naming convention: Row.Col-Label
                const yAxis = node.level + 1;
                const xAxis = node.orderInLevel + 1;
                
                const safeLabel = node.label.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_'); 
                const filename = `${yAxis}.${xAxis}-${safeLabel}.png`;

                try {
                    const canvas = await html2canvas(clone, {
                        scale: 3, // High resolution (3x)
                        backgroundColor: '#ffffff', 
                        logging: false,
                        useCORS: true,
                        allowTaint: true, // Allow cross-origin images if CORS headers present
                        onclone: (clonedDoc: Document) => {
                           // Inject font smoothing for better text
                           const style = clonedDoc.createElement('style');
                           style.innerHTML = `
                             * { 
                               -webkit-font-smoothing: antialiased;
                               -moz-osx-font-smoothing: grayscale;
                             }
                           `;
                           clonedDoc.head.appendChild(style);
                        }
                    });
                    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                    if (blob) zip.file(filename, blob);
                } catch (err) {
                    console.error(`Failed to capture node ${node.id}`, err);
                } finally {
                    document.body.removeChild(clone);
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
      const initialX = 50; 
      // Adjusted initial scale to see more cards at once since they are packed tightly
      setTransform({ x: initialX, y: 50, scale: 0.25 }); 
    }
  }, [data]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') { 
        e.preventDefault(); 
        setIsSpacePressed(true);
        // Only set cursor to grab, don't set PANNING mode until mouse down
        if (containerRef.current) containerRef.current.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        setIsSpacePressed(false);
        // If we were panning, we might want to stop, or wait for mouse up.
        // Usually, releasing space stops the *ability* to start new pans, 
        // but if dragging, we often let it finish. 
        // For simplicity, we reset cursor.
        if (interactionMode === 'IDLE') {
             if (containerRef.current) containerRef.current.style.cursor = 'default';
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [interactionMode]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // FIX: Only Pan if Space is pressed (for left click) OR if Middle Mouse (button 1)
    const isLeftClick = e.button === 0;
    const isMiddleClick = e.button === 1;

    if ((isLeftClick && isSpacePressed) || isMiddleClick) {
      setInteractionMode('PANNING');
      setDragStartMousePos({ x: e.clientX, y: e.clientY });
      setDragStartTransform({ x: transform.x, y: transform.y });
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
      e.preventDefault(); // Prevent text selection/highlighting during pan
    } else {
      // Normal click: If it hit the background directly (not handled by child), deselect
      // However, we rely on handleNodeClick stopping propagation. 
      // If we reach here and it's a left click, it might be a background click.
      if (isLeftClick) {
         setSelectedNodeId(null);
      }
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
      setInteractionMode('IDLE');
      if (containerRef.current) containerRef.current.style.cursor = isSpacePressed ? 'grab' : 'default';
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomSensitivity = 0.001;
      const delta = -e.deltaY * zoomSensitivity;
      const newScale = Math.min(Math.max(transform.scale + delta, 0.05), 3);
      setTransform(prev => ({ ...prev, scale: newScale }));
    } else {
       setTransform(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  };

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
      // If space is pressed, we are likely trying to pan, so don't select
      if (isSpacePressed) return;
      
      e.stopPropagation(); // Prevent background click (deselect)
      setSelectedNodeId(id);
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-50">
      {/* Zoom Controls */}
      <div className="absolute bottom-6 right-6 z-50 flex flex-col gap-2 bg-white p-2 rounded-xl shadow-lg border border-gray-100">
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform(t => ({...t, scale: Math.min(t.scale + 0.1, 3)}))}>
          <Plus className="w-5 h-5" />
        </button>
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform(t => ({...t, scale: Math.max(t.scale - 0.1, 0.05)}))}>
          <Minus className="w-5 h-5" />
        </button>
        <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-600" onClick={() => setTransform({ x: 50, y: 50, scale: 0.25 })}>
           <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute top-6 left-6 z-50 bg-white/80 backdrop-blur px-4 py-2 rounded-lg shadow-sm border border-gray-100 text-sm text-gray-500 pointer-events-none">
        <span className="flex items-center gap-2">
            <Move className="w-4 h-4" /> Hold Space + Drag to Pan
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
          {/* Nodes */}
          {nodes.map(node => {
            const frame = frames[node.frameIndex];
            const isSelected = selectedNodeId === node.id;

            return (
              <div
                key={node.id}
                id={`node-card-${node.id}`}
                onClick={(e) => handleNodeClick(e, node.id)}
                className={`absolute bg-white rounded-3xl shadow-[0_20px_50px_rgb(0,0,0,0.1)] flex flex-col overflow-hidden border transition-shadow duration-200 
                    ${isSelected ? 'border-indigo-500 ring-4 ring-indigo-500/20 shadow-[0_20px_60px_rgb(79,70,229,0.2)]' : 'border-gray-100 hover:shadow-[0_20px_50px_rgb(0,0,0,0.15)]'}
                `}
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