import React, { useState, useRef } from 'react';
import { extractFramesFromVideo } from './services/videoProcessor';
import { analyzeFlowWithGemini } from './services/geminiService';
import { Whiteboard, WhiteboardHandle } from './components/Whiteboard';
import { AnalysisResult, AppState, FrameData } from './types';
import { UploadCloud, Play, Loader2, AlertCircle, RefreshCw, Layers } from 'lucide-react';

export default function App() {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [frames, setFrames] = useState<FrameData[]>([]);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<string>("");
  
  const whiteboardRef = useRef<WhiteboardHandle>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setAppState(AppState.EXTRACTING_FRAMES);
      setStatusMsg("Reading video and extracting keyframes...");
      
      const extractedFrames = await extractFramesFromVideo(file);
      setFrames(extractedFrames);
      
      setAppState(AppState.ANALYZING_AI);
      setStatusMsg(`Analyzed ${extractedFrames.length} frames. Sending to Gemini for flow reconstruction...`);
      
      const result = await analyzeFlowWithGemini(extractedFrames);
      
      setAnalysisResult(result);
      setAppState(AppState.COMPLETE);

    } catch (err: any) {
      console.error(err);
      setAppState(AppState.ERROR);
      setErrorMsg(err.message || "An unexpected error occurred.");
    }
  };

  const handleExportCards = async () => {
    if (isExporting || !whiteboardRef.current) return;
    
    try {
        setIsExporting(true);
        setExportProgress("Preparing...");
        
        await whiteboardRef.current.exportCards((current, total) => {
            setExportProgress(`Exporting ${current}/${total}`);
        });
        
    } catch (err) {
        console.error("Export failed", err);
        alert("Failed to export cards.");
    } finally {
        setIsExporting(false);
        setExportProgress("");
    }
  };

  const handleRegenerateSitemap = () => {
    setAppState(AppState.IDLE);
    setFrames([]);
    setAnalysisResult(null);
    setErrorMsg("");
  };

  return (
    <div className="flex flex-col h-screen w-full font-sans text-slate-800">
      {/* Header */}
      <header className="h-16 border-b bg-white flex items-center justify-between px-6 z-10 shadow-sm shrink-0">
        <div className="flex items-center gap-2 cursor-pointer" onClick={handleRegenerateSitemap}>
          <div className="bg-indigo-600 p-1.5 rounded-lg">
             <Play className="w-5 h-5 text-white fill-current" />
          </div>
          <h1 className="font-bold text-xl tracking-tight">UI Extractor</h1>
        </div>
        
        {/* Toolbar Actions */}
        <div className="flex items-center gap-3">
           {appState === AppState.COMPLETE && (
             <>
               <button 
                 onClick={handleExportCards}
                 disabled={isExporting}
                 className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-100 rounded-md transition-all disabled:opacity-50 disabled:cursor-wait"
                 title="Download all screens as separate cards (ZIP)"
               >
                 {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                 <span>{isExporting ? exportProgress : 'Export Cards (ZIP)'}</span>
               </button>

               <div className="h-6 w-px bg-slate-200 mx-1"></div>

               <button 
                 onClick={handleRegenerateSitemap}
                 className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md transition-all"
                 title="Upload a new video to start over"
               >
                 <RefreshCw className="w-4 h-4" />
                 <span>Upload New Video</span>
               </button>
             </>
           )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden relative bg-gray-50">
        
        {/* IDLE STATE: Upload */}
        {appState === AppState.IDLE && (
          <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
            <div className="bg-white p-10 rounded-2xl shadow-xl border border-gray-100 max-w-lg w-full text-center">
              <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto mb-6">
                <UploadCloud className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Upload Interaction Recording</h2>
              <p className="text-gray-500 mb-8">
                Select a screen recording (.mp4, .mov) of an app usage. We'll automatically generate a flowchart of the screens.
              </p>
              
              <label className="block w-full cursor-pointer">
                <input 
                  type="file" 
                  accept="video/*" 
                  onChange={handleFileUpload} 
                  className="hidden" 
                />
                <div className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2">
                  <span>Select Video File</span>
                </div>
              </label>
              <p className="mt-4 text-xs text-gray-400">
                Processed locally in browser. Images sent to Gemini API.
              </p>
            </div>
          </div>
        )}

        {/* LOADING STATES */}
        {(appState === AppState.EXTRACTING_FRAMES || appState === AppState.ANALYZING_AI) && (
          <div className="flex flex-col items-center justify-center h-full animate-pulse">
            <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
            <h3 className="text-xl font-semibold text-gray-800">{appState === AppState.EXTRACTING_FRAMES ? 'Processing Video' : 'AI Analysis'}</h3>
            <p className="text-gray-500 mt-2">{statusMsg}</p>
            
            {/* Visual feedback of frames being processed */}
            {frames.length > 0 && (
               <div className="mt-8 flex gap-2 overflow-hidden max-w-2xl opacity-50 px-4">
                  {frames.slice(0, 8).map((f, i) => (
                    <img key={i} src={f.dataUrl} className="h-16 w-auto rounded border shadow-sm" alt="" />
                  ))}
                  {frames.length > 8 && <div className="h-16 flex items-center text-gray-400 text-xs">+{frames.length - 8} frames</div>}
               </div>
            )}
          </div>
        )}

        {/* COMPLETE STATE: Whiteboard */}
        {appState === AppState.COMPLETE && analysisResult && (
          <Whiteboard 
            ref={whiteboardRef}
            data={analysisResult} 
            frames={frames} 
          />
        )}

        {/* ERROR STATE */}
        {appState === AppState.ERROR && (
          <div className="flex flex-col items-center justify-center h-full p-6">
            <div className="bg-red-50 p-8 rounded-xl border border-red-100 max-w-md text-center">
              <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-red-800 mb-2">Analysis Failed</h3>
              <p className="text-red-600 mb-6">{errorMsg}</p>
              <div className="flex justify-center gap-3">
                 <button 
                  onClick={handleRegenerateSitemap}
                  className="bg-white border border-red-200 text-red-700 hover:bg-red-50 font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  Try Again (New Video)
                </button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}