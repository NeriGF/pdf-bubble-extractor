'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { usePostHog } from 'posthog-js/react';

type Bubble = {
  title: string;
  type: 'date' | 'money' | 'risk' | 'action';
  importance: 'high' | 'medium' | 'low';
  summary: string;
  consequence: string;
  action: string;
  sourcePage?: number;
  sourceText?: string;
  confidenceScore?: number;
};

type TextSegment = {
  text: string;
  isHighlight: boolean;
  bubbleIdx?: number;
  isPageMarker?: boolean;
  pageNum?: string;
};

type PageData = {
  pageNum: number;
  segments: TextSegment[];
};

function findMatch(docText: string, sourceText?: string) {
  if (!sourceText) return { index: -1, length: 0 };
  
  // Try exact match first
  let idx = docText.indexOf(sourceText);
  if (idx !== -1) return { index: idx, length: sourceText.length };

  // Try fuzzy match
  const normalize = (t: string) => t.replace(/\s+/g, ' ').trim();
  const normSource = normalize(sourceText);
  if (!normSource) return { index: -1, length: 0 };

  const escapedSource = normSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = escapedSource.split(' ').join('\\s+');
  
  try {
    const regex = new RegExp(regexPattern, 'i');
    const match = docText.match(regex);
    if (match && match.index !== undefined) {
      return { index: match.index, length: match[0].length };
    }
  } catch(e) {}

  // Try partial phrase match
  const words = normSource.split(' ');
  if (words.length > 4) {
    const halfPattern = words.slice(0, Math.floor(words.length / 2)).join('\\s+');
    try {
      const halfRegex = new RegExp(halfPattern, 'i');
      const match = docText.match(halfRegex);
      if (match && match.index !== undefined) {
        return { index: match.index, length: match[0].length };
      }
    } catch(e) {}
  }

  return { index: -1, length: 0 };
}

type BubbleLayout = {
  isBottom: boolean;
  top?: number;
  left?: number;
  right?: number;
  line: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    colorClass: string;
    idx: number;
  };
};

const getIconForType = (type: string) => {
  switch (type) {
    case 'risk':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      );
    case 'action':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10"></polyline>
          <polyline points="23 20 23 14 17 14"></polyline>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
        </svg>
      );
    case 'money':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2"></rect>
          <line x1="2" y1="10" x2="22" y2="10"></line>
        </svg>
      );
    case 'date':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
      );
    default:
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
      );
  }
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [documentText, setDocumentText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasProcessed, setHasProcessed] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [showAllInsights, setShowAllInsights] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const highlightRefs = useRef<(HTMLElement | null)[]>([]);
  const workspaceRef = useRef<HTMLDivElement>(null);
  
  const [bubbleLayouts, setBubbleLayouts] = useState<BubbleLayout[]>([]);

  const posthog = usePostHog();

  const trackEvent = (eventName: string, properties?: Record<string, any>) => {
    console.log(`[PostHog] Event: ${eventName}`, properties || '');
    if (posthog) {
      posthog.capture(eventName, properties);
    }
  };

  // Compute visibility
  const visibleIndices = useMemo(() => {
    if (showAllInsights) return bubbles.map((_, i) => i);
    
    const importanceScore = { 'high': 3, 'medium': 2, 'low': 1 };
    return bubbles
      .map((b, i) => ({ idx: i, score: importanceScore[b.importance] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(item => item.idx);
  }, [bubbles, showAllInsights]);

  const visibleBubblesSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
      setHasProcessed(false);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setIsLoading(true);
    setError(null);
    setBubbles([]);
    setDocumentText('');
    setHasProcessed(false);
    setHoveredIdx(null);
    setShowAllInsights(false);
    setBubbleLayouts([]);
    setCurrentPage(1);

    trackEvent('pdf_uploaded', { fileName: file.name, fileSize: file.size });

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/extract', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to process PDF');
      }

      const data = await response.json();
      if (data.bubbles && data.documentText) {
        setBubbles(data.bubbles);
        setDocumentText(data.documentText);
        setHasProcessed(true);
        trackEvent('annotations_generated', { bubbleCount: data.bubbles.length });
        trackEvent('document_completed', { fileName: file.name });
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err: any) {
      setError(err.message);
      trackEvent('upload_failed', { error: err.message, fileName: file.name });
    } finally {
      setIsLoading(false);
    }
  };

  let anchoredCount = 0;
  let unanchoredIndices = new Set<number>();

  const bubblePageMap: Record<number, number> = {};
  const pages: PageData[] = [];

  if (documentText && bubbles.length > 0) {
    const matches = bubbles.map((b, i) => {
      const match = findMatch(documentText, b.sourceText);
      return {
        bubbleIdx: i,
        index: match.index,
        length: match.length,
        isAnchored: match.index !== -1
      };
    });

    anchoredCount = matches.filter(m => m.isAnchored).length;
    unanchoredIndices = new Set(matches.filter(m => !m.isAnchored).map(m => m.bubbleIdx));

    const validMatches = matches
      .filter(m => m.index !== -1 && visibleBubblesSet.has(m.bubbleIdx));

    const allMarkers: any[] = [];
    
    for (const m of validMatches) {
      allMarkers.push({ type: 'bubble', ...m });
    }
    
    const pageRegex = /---\s*PAGE\s+(\d+)\s*---/g;
    let pageMatch;
    while ((pageMatch = pageRegex.exec(documentText)) !== null) {
      allMarkers.push({
        type: 'page',
        index: pageMatch.index,
        length: pageMatch[0].length,
        pageNum: pageMatch[1]
      });
    }

    allMarkers.sort((a, b) => a.index - b.index);

    const filteredMarkers: typeof allMarkers = [];
    let lastEnd = 0;
    for (const m of allMarkers) {
      if (m.index >= lastEnd) {
        filteredMarkers.push(m);
        lastEnd = m.index + m.length;
      }
    }

    let currentIdx = 0;
    let currentSegments: TextSegment[] = [];
    let currentPageNum = 1;
    let pageHasContent = false;

    const pushToPage = () => {
      if (currentSegments.length > 0 || pageHasContent) {
        pages.push({ pageNum: currentPageNum, segments: currentSegments });
        currentSegments = [];
        pageHasContent = false;
      }
    };

    for (const match of filteredMarkers) {
      if (match.index > currentIdx) {
        currentSegments.push({ text: documentText.substring(currentIdx, match.index), isHighlight: false });
        pageHasContent = true;
      }
      if (match.type === 'bubble') {
        currentSegments.push({ 
          text: documentText.substring(match.index, match.index + match.length), 
          isHighlight: true,
          bubbleIdx: match.bubbleIdx
        });
        bubblePageMap[match.bubbleIdx] = currentPageNum;
        pageHasContent = true;
      } else if (match.type === 'page') {
        pushToPage();
        currentPageNum = parseInt(match.pageNum, 10) || currentPageNum + 1;
      }
      currentIdx = match.index + match.length;
    }
    if (currentIdx < documentText.length) {
      currentSegments.push({ text: documentText.substring(currentIdx), isHighlight: false });
      pageHasContent = true;
    }
    pushToPage();
  } else if (documentText) {
    const pageRegex = /---\s*PAGE\s+(\d+)\s*---/g;
    let currentIdx = 0;
    let currentSegments: TextSegment[] = [];
    let currentPageNum = 1;
    let match;
    while ((match = pageRegex.exec(documentText)) !== null) {
      if (match.index > currentIdx) {
        currentSegments.push({ text: documentText.substring(currentIdx, match.index), isHighlight: false });
      }
      if (currentSegments.length > 0) {
        pages.push({ pageNum: currentPageNum, segments: currentSegments });
      }
      currentSegments = [];
      currentPageNum = parseInt(match[1], 10);
      currentIdx = match.index + match[0].length;
    }
    if (currentIdx < documentText.length) {
      currentSegments.push({ text: documentText.substring(currentIdx), isHighlight: false });
      pages.push({ pageNum: currentPageNum, segments: currentSegments });
    }
  }

  const activePageData = pages.find(p => p.pageNum === currentPage) || pages[0] || { pageNum: 1, segments: [] };

  useEffect(() => {
    if (!workspaceRef.current || bubbles.length === 0) return;

    const updatePositions = () => {
      const workspaceNode = workspaceRef.current;
      if (!workspaceNode) return;
      
      const workspaceRect = workspaceNode.getBoundingClientRect();
      const docNode = workspaceNode.querySelector('.document-container');
      const docRect = docNode ? docNode.getBoundingClientRect() : workspaceRect;

      const layouts: BubbleLayout[] = [];

      const leftOccupied: {top: number, bottom: number}[] = [];
      const rightOccupied: {top: number, bottom: number}[] = [];
      const CARD_HEIGHT = 200; 
      const VERTICAL_SPACING = 20;

      const findAvailableY = (idealY: number, occupied: {top: number, bottom: number}[]) => {
         let proposedY = Math.max(0, idealY);
         let hasOverlap = true;
         
         const sorted = [...occupied].sort((a, b) => a.top - b.top);
         
         while (hasOverlap) {
           hasOverlap = false;
           for (const box of sorted) {
             if (proposedY < box.bottom + VERTICAL_SPACING && proposedY + CARD_HEIGHT > box.top - VERTICAL_SPACING) {
               proposedY = box.bottom + VERTICAL_SPACING;
               hasOverlap = true;
             }
           }
         }
         return proposedY;
      };

      for (let i = 0; i < bubbles.length; i++) {
        if (!visibleBubblesSet.has(i)) continue;

        const bubble = bubbles[i];
        const hNode = highlightRefs.current[i];
        if (!hNode || !hNode.offsetParent) continue;
        
        const hRect = hNode.getBoundingClientRect();
        const dotNode = hNode.querySelector('.anchor-dot');
        const dRect = dotNode ? dotNode.getBoundingClientRect() : hRect;
        
        // Exact center of the anchor dot
        const anchorX = dRect.left + (dRect.width / 2) - workspaceRect.left + workspaceNode.scrollLeft;
        const anchorY = dRect.top + (dRect.height / 2) - workspaceRect.top + workspaceNode.scrollTop;
        
        if (bubble.importance === 'low') {
           const cardNode = document.getElementById(`bubble-card-${i}`);
           if (cardNode) {
             const cRect = cardNode.getBoundingClientRect();
             const endX = cRect.left + (cRect.width / 2) - workspaceRect.left + workspaceNode.scrollLeft;
             const endY = cRect.top - workspaceRect.top + workspaceNode.scrollTop - 5;
             
             layouts[i] = {
               isBottom: true,
               line: { x1: anchorX, y1: anchorY, x2: endX, y2: endY, colorClass: `line-${bubble.importance}`, idx: i }
             };
           }
        } else {
          // Strictly use physical side to keep lines short and clear
          const chooseLeft = (hRect.left - workspaceRect.left) < workspaceRect.width / 2;
          const cardWidth = 320;
          let idealTop = hRect.top - workspaceRect.top + workspaceNode.scrollTop - 10;
          
          let cardTop, cardLeft, endX, endY;
          if (chooseLeft) {
            cardTop = findAvailableY(idealTop, leftOccupied);
            leftOccupied.push({top: cardTop, bottom: cardTop + CARD_HEIGHT});
            
            // Place closer to document instead of absolute workspace edge
            const docLeftX = docRect.left - workspaceRect.left + workspaceNode.scrollLeft;
            cardLeft = docLeftX - cardWidth - 30; // 30px gap from document
            if (cardLeft < 20) cardLeft = 20; // safety margin
            
            endX = cardLeft + cardWidth;
            endY = cardTop + 40;
          } else {
            cardTop = findAvailableY(idealTop, rightOccupied);
            rightOccupied.push({top: cardTop, bottom: cardTop + CARD_HEIGHT});
            
            const docRightX = docRect.right - workspaceRect.left + workspaceNode.scrollLeft;
            cardLeft = docRightX + 30; // 30px gap from document
            if (cardLeft + cardWidth > workspaceRect.width - 20) {
              cardLeft = workspaceRect.width - cardWidth - 20; // safety margin
            }
            
            endX = cardLeft;
            endY = cardTop + 40;
          }

          layouts[i] = {
            isBottom: false,
            top: cardTop,
            left: cardLeft,
            line: { x1: anchorX, y1: anchorY, x2: endX, y2: endY, colorClass: `line-${bubble.importance}`, idx: i }
          };
        }
      }
      setBubbleLayouts(layouts);
    };

    // Use a small delay to ensure rendering of any new bottom cards before measuring
    const timeout = setTimeout(updatePositions, 150);
    window.addEventListener('resize', updatePositions);

    return () => {
      clearTimeout(timeout);
      window.removeEventListener('resize', updatePositions);
    };
  }, [bubbles, documentText, showAllInsights, visibleBubblesSet, currentPage]);

  const renderCardContent = (bubble: Bubble) => (
    <>
      <div className="card-header">
        <div className="card-title-wrap">
          <span className={`icon icon-${bubble.importance}`}>{getIconForType(bubble.type)}</span>
          <span className="card-title">{bubble.title}</span>
        </div>
        <span className={`badge badge-${bubble.importance}`}>{bubble.importance}</span>
      </div>
      <div className="card-details">
        <p className="detail-summary">{bubble.summary}</p>
        {bubble.consequence && (
          <div className="detail-section">
            <strong>Risk:</strong>
            <p>{bubble.consequence}</p>
          </div>
        )}
        {bubble.action && (
          <div className="detail-section">
            <strong>Action:</strong>
            <p>{bubble.action}</p>
          </div>
        )}
      </div>
    </>
  );

  return (
    <main className="app-container">
      <header className="app-header">
        <h1>PDF Bubble Extractor</h1>
        <p>A living document with anchored AI insights.</p>
      </header>

      {hasProcessed && (
        <div className="debug-panel">
          <div><strong>Total Pages Processed:</strong> {pages.length}</div>
          <div><strong>Total Insights Found:</strong> {bubbles.length}</div>
          <div><strong>Insights Per Page:</strong> {pages.length ? (bubbles.length / pages.length).toFixed(1) : 0}</div>
        </div>
      )}

      {!hasProcessed && !isLoading && (
        <section 
          className="upload-section" 
          onClick={() => fileInputRef.current?.click()}
        >
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept="application/pdf"
            className="upload-input"
          />
          <p style={{ marginBottom: '1.5rem', fontSize: '1.2rem' }}>
            {file ? file.name : "Click to select a PDF file"}
          </p>
          <button 
            type="button"
            className="upload-btn" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (file) handleUpload();
              else fileInputRef.current?.click();
            }}
            disabled={!file || isLoading}
          >
            {isLoading ? "Processing..." : file ? "Process PDF" : "Browse Files"}
          </button>
          {error && <p style={{ color: '#ef4444', marginTop: '1rem' }}>{error}</p>}
        </section>
      )}

      {isLoading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Extracting insights and generating callouts...</p>
        </div>
      )}

      {hasProcessed && (
        <div className="workspace" ref={workspaceRef}>
          <svg className="lines-overlay">
            {bubbleLayouts.map((layout, idx) => {
              if (!layout || !visibleBubblesSet.has(idx) || bubblePageMap[idx] !== currentPage) return null;
              const line = layout.line;
              let pathData = '';
              if (layout.isBottom) {
                // Draw line downwards
                const dy = Math.abs(line.y2 - line.y1) / 2;
                pathData = `M ${line.x1} ${line.y1} C ${line.x1} ${line.y1 + dy}, ${line.x2} ${line.y2 - dy}, ${line.x2} ${line.y2}`;
              } else {
                // Draw line sideways
                const isLeft = line.x2 > line.x1;
                const dx = Math.min(Math.abs(line.x2 - line.x1) * 0.4, 40);
                pathData = `M ${line.x1} ${line.y1} C ${line.x1 + (isLeft ? dx : -dx)} ${line.y1}, ${line.x2 + (isLeft ? -dx : dx)} ${line.y2}, ${line.x2} ${line.y2}`;
              }
              
              return (
                <path 
                  key={line.idx}
                  d={pathData}
                  className={`connection-line ${line.colorClass} ${hoveredIdx === line.idx ? 'line-active' : ''}`}
                />
              );
            })}
          </svg>

          <div className="workspace-layout">
            <div className="sidebar-insights">
              <h2>Top Insights</h2>
              {bubbles.map((bubble, idx) => {
                if (!visibleBubblesSet.has(idx)) return null;
                const isUnanchored = unanchoredIndices.has(idx);
                const isHovered = hoveredIdx === idx;
                return (
                  <div 
                    key={idx}
                    className={`sidebar-card style-${bubble.importance} ${isHovered ? 'card-hovered' : ''}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onClick={() => {
                      if (!isUnanchored && bubblePageMap[idx]) {
                        setCurrentPage(bubblePageMap[idx]);
                        setTimeout(() => {
                           const node = highlightRefs.current[idx];
                           if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }, 100);
                      }
                    }}
                  >
                    <div className="card-header">
                      <div className="card-title-wrap">
                        <span className={`icon icon-${bubble.importance}`}>{getIconForType(bubble.type)}</span>
                        <span className="card-title" style={{ fontSize: '0.9rem' }}>{bubble.title}</span>
                      </div>
                    </div>
                    {isUnanchored && <span className="unanchored-tag">Unanchored</span>}
                  </div>
                );
              })}
            </div>

            <div className="document-container">
              
              {unanchoredIndices.size > 0 && (
                <div className="warning-banner">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  Insights generated, but source text could not be matched.
                </div>
              )}

              <div className="document-view">
                {activePageData.segments.map((seg, idx) => {
                if (seg.isPageMarker) {
                  return (
                    <div key={idx} className="page-divider">
                      <span>Page {seg.pageNum}</span>
                    </div>
                  );
                }
                if (seg.isHighlight) {
                  const bubble = bubbles[seg.bubbleIdx!];
                  const isHovered = hoveredIdx === seg.bubbleIdx;
                  return (
                    <span 
                      key={idx}
                      ref={el => { highlightRefs.current[seg.bubbleIdx!] = el }}
                      className={`inline-container highlight highlight-${bubble.importance} ${isHovered ? 'highlight-active' : ''}`}
                      onMouseEnter={() => setHoveredIdx(seg.bubbleIdx!)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    >
                      {seg.text}
                      <span className={`anchor-dot dot-${bubble.importance}`}></span>
                    </span>
                  );
                }
                return <span key={idx}>{seg.text}</span>;
              })}
            </div>
            
            <div className="bottom-cards-row">
              {bubbles.map((bubble, idx) => {
                if (bubble.importance !== 'low' || !visibleBubblesSet.has(idx) || unanchoredIndices.has(idx)) return null;
                if (bubblePageMap[idx] !== currentPage) return null;
                const isHovered = hoveredIdx === idx;
                return (
                  <div 
                    key={idx}
                    id={`bubble-card-${idx}`}
                    className={`callout-card bottom-card style-${bubble.importance} ${isHovered ? 'card-hovered' : ''}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onClick={() => trackEvent('callout_clicked', { title: bubble.title, type: bubble.type, importance: bubble.importance, cardPosition: 'bottom' })}
                  >
                    {renderCardContent(bubble)}
                  </div>
                );
              })}
            </div>

            {unanchoredIndices.size > 0 && (
              <div className="top-insights-section">
                <h2>Top Insights (Unanchored)</h2>
                <div className="bottom-cards-row">
                  {bubbles.map((bubble, idx) => {
                    if (!unanchoredIndices.has(idx)) return null;
                    const isHovered = hoveredIdx === idx;
                    return (
                      <div 
                        key={idx}
                        id={`bubble-card-${idx}`}
                        className={`callout-card bottom-card style-${bubble.importance} ${isHovered ? 'card-hovered' : ''}`}
                        onMouseEnter={() => setHoveredIdx(idx)}
                        onMouseLeave={() => setHoveredIdx(null)}
                        onClick={() => trackEvent('callout_clicked', { title: bubble.title, type: bubble.type, importance: bubble.importance, cardPosition: 'unanchored' })}
                      >
                        {renderCardContent(bubble)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="pagination-controls">
              <button 
                className="pagination-btn"
                disabled={pages.findIndex(p => p.pageNum === currentPage) <= 0}
                onClick={() => {
                  const idx = pages.findIndex(p => p.pageNum === currentPage);
                  if (idx > 0) setCurrentPage(pages[idx - 1].pageNum);
                }}
              >
                &larr; Previous Page
              </button>
              <span className="page-indicator">Page {currentPage} of {pages[pages.length - 1]?.pageNum || 1}</span>
              <button 
                className="pagination-btn"
                disabled={pages.findIndex(p => p.pageNum === currentPage) >= pages.length - 1}
                onClick={() => {
                  const idx = pages.findIndex(p => p.pageNum === currentPage);
                  if (idx < pages.length - 1) setCurrentPage(pages[idx + 1].pageNum);
                }}
              >
                Next Page &rarr;
              </button>
            </div>
            
            {bubbles.length > 6 && (
              <div className="toggle-insights-container">
                <button 
                  className="toggle-insights-btn"
                  onClick={() => setShowAllInsights(!showAllInsights)}
                >
                  {showAllInsights ? "Show fewer insights" : `Show all insights (${bubbles.length})`}
                </button>
              </div>
            )}
          </div>

          <div className="callouts-overlay">
            {bubbles.map((bubble, idx) => {
              if (bubble.importance === 'low' || !visibleBubblesSet.has(idx) || unanchoredIndices.has(idx)) return null;
              if (bubblePageMap[idx] !== currentPage) return null;
              
              const layout = bubbleLayouts[idx];
              if (!layout) return null;
              
              const isHovered = hoveredIdx === idx;

              return (
                <div 
                  key={idx}
                  id={`bubble-card-${idx}`}
                  className={`callout-card side-card style-${bubble.importance} ${isHovered ? 'card-hovered' : ''}`}
                  style={{ top: layout.top, left: layout.left, right: layout.right }}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => trackEvent('callout_clicked', { title: bubble.title, type: bubble.type, importance: bubble.importance, cardPosition: 'side' })}
                >
                  {renderCardContent(bubble)}
                </div>
              );
            })}
          </div>
        </div>
        </div>
      )}
    </main>
  );
}
