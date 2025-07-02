'use client'

import React, { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'

interface PageNode {
  id: string
  title: string
  url: string
  depth: number
  children: PageNode[]
  status: 'analyzed' | 'pending' | 'error'
  metadata?: {
    title: string
    description: string
    images: number
    links: number
    wordCount: number
  }
  screenshotPath: string
  htmlPath: string
}

interface AnalysisStats {
  totalPages: number
  totalImages: number
  totalLinks: number
  totalWords: number
  analysisTime: number
}

interface CrawlResult {
  id: string
  url: string
  title: string
  pageType: string
  links: string[]
  images: string[]
  headings: { level: string; text: string }[]
  forms: number
  buttons: string[]
  textContent: string
  screenshotPath: string
  htmlPath: string
  timestamp: string
  metadata: {
    wordCount: number
    imageCount: number
    linkCount: number
  }
}

interface PageResult {
  id: string;
  url: string;
  title: string;
  pageType: string;
  links: string[];
  images: string[];
  buttons: string[];
  headings: { level: string; text: string }[];
  forms: number;
  textContent: string;
  screenshotPath: string;
  htmlPath: string;
  timestamp: string;
  metadata: {
    wordCount: number;
    imageCount: number;
    linkCount: number;
  };
}

interface NetworkNode {
  id: string;
  label: string;
  color: string;
  type: string;
  url: string;
  title: string;
  screenshot: string;
}

interface NetworkEdge {
  from: string;
  to: string;
}

interface NetworkData {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

interface AnalysisResult {
  results: PageResult[];
  networkData: NetworkData;
  totalPages: number;
  isPreview: boolean;
  previewLimit: number;
  message: string;
}

type ViewMode = 'structure' | 'network';

export default function AnalyzePage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const url = searchParams.get('url')
  
  const [isAnalyzing, setIsAnalyzing] = useState(true)
  const [progress, setProgress] = useState(0)
  const [siteMap, setSiteMap] = useState<PageNode[]>([])
  const [selectedNode, setSelectedNode] = useState<PageNode | null>(null)
  const [stats, setStats] = useState<AnalysisStats | null>(null)
  const [showSignupModal, setShowSignupModal] = useState(false)
  const [analysisId, setAnalysisId] = useState<string | null>(null)
  const [isPreview, setIsPreview] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('structure')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [isCheckingAuth, setIsCheckingAuth] = useState(false)
  const [loadingPageDetails, setLoadingPageDetails] = useState(false)
  const [pageDetailsCache, setPageDetailsCache] = useState<Record<string, any>>({})

  useEffect(() => {
    if (!url) {
      router.push('/')
      return
    }

    // 로그인 필요 없이 바로 미리보기 분석 시작
    startAnalysis()
  }, [url, router])

  const startAnalysis = async () => {
    try {
      setIsAnalyzing(true)
      setError(null)
      
      // Next.js API 프록시를 통한 백엔드 API 호출 (CORS 우회)
      const response = await fetch('/api/crawler/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url! }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      console.log('Crawl results:', data)

      // 진행률 시뮬레이션
      const progressInterval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval)
            return 90
          }
          return prev + Math.random() * 15
        })
      }, 500)

      // 4초 후 완료
      setTimeout(() => {
        clearInterval(progressInterval)
        setProgress(100)

        // 실제 API 응답 데이터 처리
        if (data && data.results) {
          const processedSiteMap = buildSiteMapFromResults(data.results)
          setSiteMap(processedSiteMap)
          setSelectedNode(processedSiteMap[0] || null)
          
          const calculatedStats = calculateStatsFromResults(data.results)
          setStats(calculatedStats)
          setResult(data)
        }
        
        setIsAnalyzing(false)
        setIsPreview(true)
      }, 4000)

    } catch (error) {
      console.error('Analysis failed:', error)
      setError('Failed to analyze website. Please try again.')
      setIsAnalyzing(false)
    }
  }

  const buildSiteMapFromResults = (results: CrawlResult[]): PageNode[] => {
    if (!results || results.length === 0) return []

    const urlToNode = new Map<string, PageNode>()
    
    // 모든 페이지를 노드로 변환
    results.forEach(result => {
      const node: PageNode = {
        id: result.id,
        title: result.title || 'Untitled',
        url: result.url,
        depth: 0,
        children: [],
        status: 'analyzed',
        metadata: {
          title: result.title,
          description: result.textContent.substring(0, 200) + '...',
          images: result.metadata.imageCount,
          links: result.metadata.linkCount,
          wordCount: result.metadata.wordCount
        },
        screenshotPath: result.screenshotPath,
        htmlPath: result.htmlPath
      }
      urlToNode.set(result.url, node)
    })

    // 계층 구조 생성
    const rootNodes: PageNode[] = []
    const baseUrl = new URL(url!).origin

    results.forEach(result => {
      const node = urlToNode.get(result.url)!
      
      // 홈페이지 또는 루트에 가까운 페이지를 루트로 설정
      if (result.url === baseUrl || result.url === baseUrl + '/' || result.pageType === 'homepage') {
        node.depth = 0
        rootNodes.push(node)
      } else {
        // 링크 관계를 기반으로 부모-자식 관계 설정
        let parentFound = false
        results.forEach(parentResult => {
          if (parentResult.links.includes(result.url) && parentResult.url !== result.url) {
            const parentNode = urlToNode.get(parentResult.url)
            if (parentNode && !parentNode.children.find(child => child.id === node.id)) {
              node.depth = parentNode.depth + 1
              parentNode.children.push(node)
              parentFound = true
            }
          }
        })
        
        // 부모를 찾지 못한 경우 루트에 추가
        if (!parentFound) {
          node.depth = 1
          if (rootNodes.length > 0) {
            rootNodes[0].children.push(node)
          } else {
            rootNodes.push(node)
          }
        }
      }
    })

    return rootNodes.length > 0 ? rootNodes : Array.from(urlToNode.values()).slice(0, 1)
  }

  const calculateStatsFromResults = (results: CrawlResult[]): AnalysisStats => {
    return {
      totalPages: results.length,
      totalImages: results.reduce((sum, r) => sum + r.metadata.imageCount, 0),
      totalLinks: results.reduce((sum, r) => sum + r.metadata.linkCount, 0),
      totalWords: results.reduce((sum, r) => sum + r.metadata.wordCount, 0),
      analysisTime: 4.2
    }
  }

  const handleDownload = (pageId?: string, fileType?: 'png' | 'html') => {
    if (isPreview) {
      setShowSignupModal(true)
    } else {
      // 실제 다운로드 로직 (로그인된 사용자용)
      if (pageId && fileType && analysisId) {
        downloadFile(analysisId, pageId, fileType)
      }
    }
  }

  const downloadFile = async (analysisId: string, pageId: string, fileType: 'png' | 'html') => {
    try {
      const token = localStorage.getItem('token')
      if (!token) {
        setShowSignupModal(true)
        return
      }

      const response = await fetch(`http://localhost:3003/crawler/download/${analysisId}/${pageId}/${fileType}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        throw new Error('Download failed')
      }

      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = `page-${pageId}.${fileType}`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(downloadUrl)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  const getScreenshotUrl = (screenshotPath: string) => {
    // Next.js API 프록시를 통한 스크린샷 URL 반환 (CORS 우회)
    if (screenshotPath) {
      // 임시 미리보기 스크린샷 경로 처리: /temp/preview_xxx/screenshots/xxx.png 또는 details_xxx
      if (screenshotPath.includes('/temp/')) {
        const pathParts = screenshotPath.split('/')
        const tempId = pathParts.find(part => part.startsWith('preview_') || part.startsWith('details_'))
        const filename = pathParts[pathParts.length - 1]
        
        if (tempId && filename) {
          return `/api/crawler/temp-screenshot/${tempId}/${filename}`
        }
      }
      
      // 일반 업로드 스크린샷 경로 처리: /uploads/xxx/screenshots/xxx.png
      if (screenshotPath.startsWith('/uploads/')) {
        // 추후 업로드 스크린샷용 API 프록시 추가 예정
        return `http://localhost:3003${screenshotPath}`
      }
    }
    
    // 백업용 목업 이미지
    return 'data:image/svg+xml;base64,' + btoa(`
      <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(147,51,234);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgb(59,130,246);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad1)"/>
        <rect x="20" y="20" width="360" height="40" fill="white" rx="8"/>
        <rect x="30" y="80" width="340" height="20" fill="rgba(255,255,255,0.8)" rx="4"/>
        <rect x="30" y="110" width="280" height="20" fill="rgba(255,255,255,0.6)" rx="4"/>
        <rect x="30" y="140" width="320" height="20" fill="rgba(255,255,255,0.7)" rx="4"/>
        <rect x="30" y="180" width="160" height="80" fill="rgba(255,255,255,0.9)" rx="8"/>
        <rect x="210" y="180" width="160" height="80" fill="rgba(255,255,255,0.9)" rx="8"/>
        <text x="200" y="35" font-family="Arial, sans-serif" font-size="16" fill="#374151" text-anchor="middle">Website Screenshot Preview</text>
      </svg>
    `)
  }

  // 페이지 상세 정보 가져오기 (스크린샷 + HTML)
  const loadPageDetails = async (url: string) => {
    try {
      console.log('Loading page details for:', url)
      
      const response = await fetch('/api/crawler/page-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      console.log('Page details loaded:', data)
      
      return data
    } catch (error) {
      console.error('Failed to load page details:', error)
      throw error
    }
  }

  // 노드 클릭 핸들러 - 상세 정보 로드
  const handleNodeClick = async (node: PageNode) => {
    setSelectedNode(node)
    
    // 이미 스크린샷이 있거나 캐시에 있으면 추가 로드하지 않음
    if (node.screenshotPath || pageDetailsCache[node.url]) {
      return
    }

    // 상세 정보 로드
    setLoadingPageDetails(true)
    try {
      const details = await loadPageDetails(node.url)
      
      // 캐시에 저장
      setPageDetailsCache(prev => ({
        ...prev,
        [node.url]: details
      }))
      
      // 선택된 노드 업데이트
      const updatedNode = {
        ...node,
        screenshotPath: details.screenshotPath,
        htmlPath: details.htmlPath
      }
      setSelectedNode(updatedNode)
      
    } catch (error) {
      console.error('Failed to load page details:', error)
    } finally {
      setLoadingPageDetails(false)
    }
  }

  const renderTreeNode = (node: PageNode, visited = new Set<string>()): React.ReactNode => {
    // 순환 참조로 인한 무한 재귀 방지
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    const isSelected = selectedNode?.id === node.id
    const indentLevel = node.depth * 20
    
    return (
      <div key={node.id}>
        <div
          className={`flex items-center py-2 px-3 rounded-lg cursor-pointer transition-all ${
            isSelected
              ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg'
              : 'hover:bg-white/60 text-gray-700'
          }`}
          style={{ marginLeft: `${indentLevel}px` }}
          onClick={() => handleNodeClick(node)}
        >
          <div className="flex items-center flex-1">
            {node.children.length > 0 && (
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
            <div className={`w-2 h-2 rounded-full mr-3 ${
              node.status === 'analyzed' ? 'bg-green-400' :
              node.status === 'pending' ? 'bg-yellow-400' : 'bg-red-400'
            }`}></div>
            <span className="font-medium truncate">{node.title}</span>
          </div>
          {node.metadata && (
            <div className="flex items-center space-x-2 text-xs">
              <span className="bg-white/20 px-2 py-1 rounded">{node.metadata.images}img</span>
              <span className="bg-white/20 px-2 py-1 rounded">{node.metadata.links}links</span>
            </div>
          )}
        </div>
        {node.children.map(child => renderTreeNode(child, visited))}
      </div>
    )
  }

  const NetworkVisualization = ({ networkData }: { networkData: NetworkData }) => {
    const [zoom, setZoom] = useState(1)
    const [panX, setPanX] = useState(0)
    const [panY, setPanY] = useState(0)
    const [isDragging, setIsDragging] = useState(false)
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

    useEffect(() => {
      if (!networkData?.nodes?.length) return

      const container = document.getElementById('network-container')
      if (!container) return

      // 노드를 depth별로 그룹화
      const nodesByDepth = networkData.nodes.reduce((acc, node) => {
        // ID에서 depth 정보 추출: preview_timestamp_index_depthN
        const depthMatch = node.id.match(/depth(\d+)/)
        const depth = depthMatch ? parseInt(depthMatch[1]) : 0
        if (!acc[depth]) acc[depth] = []
        acc[depth].push(node)
        return acc
      }, {} as Record<number, typeof networkData.nodes>)

      const maxDepth = Math.max(...Object.keys(nodesByDepth).map(Number))
      const svgWidth = Math.max(1200, (maxDepth + 1) * 300) // 왼쪽에서 오른쪽으로 더 넓게
      const svgHeight = 800
      
      // 왼쪽에서 오른쪽으로 계층적 레이아웃 계산 (수평 배치)
      const nodes = networkData.nodes.map(node => {
        const depthMatch = node.id.match(/depth(\d+)/)
        const depth = depthMatch ? parseInt(depthMatch[1]) : 0
        const nodesAtDepth = nodesByDepth[depth]
        const indexAtDepth = nodesAtDepth.indexOf(node)
        const totalAtDepth = nodesAtDepth.length
        
        // 각 depth별로 세로로 균등 배치, depth는 가로로 배치
        const x = 150 + depth * 280 // depth별로 가로로 배치 (왼쪽에서 오른쪽)
        const y = (svgHeight / (totalAtDepth + 1)) * (indexAtDepth + 1) // 세로로 균등 배치
        
        return {
          ...node,
          x,
          y,
          depth
        }
      })
      
      container.innerHTML = `
        <div class="bg-white border rounded-lg overflow-hidden">
          <!-- 네트워크 맵 헤더 -->
          <div class="p-4 border-b bg-gray-50 flex justify-between items-center">
            <h3 class="text-lg font-semibold">웹사이트 계층 구조 (왼쪽→오른쪽)</h3>
            
            <!-- 컨트롤 버튼들 -->
            <div class="flex items-center gap-2">
              <button id="zoom-in" class="p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors" title="확대">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                </svg>
              </button>
              <button id="zoom-out" class="p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors" title="축소">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 12H6"></path>
                </svg>
              </button>
              <button id="reset-view" class="p-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors" title="초기화">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
              </button>
              <span class="text-sm text-gray-600 ml-2">${Math.round(zoom * 100)}%</span>
            </div>
          </div>

          <!-- 스크롤 가능한 네트워크 맵 영역 -->
          <div class="relative">
            <div id="network-viewport" class="overflow-auto" style="height: 400px; cursor: grab;">
              <svg id="network-svg" width="${svgWidth}" height="${svgHeight}" 
                   style="background: linear-gradient(to right, #f8fafc, #f1f5f9); min-width: ${svgWidth}px;">
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" 
                          refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
                  </marker>
                  <filter id="drop-shadow">
                    <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.3"/>
                  </filter>
                  <linearGradient id="depth0" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#ef4444;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#dc2626;stop-opacity:1" />
                  </linearGradient>
                  <linearGradient id="depth1" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#f97316;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#ea580c;stop-opacity:1" />
                  </linearGradient>
                  <linearGradient id="depth2" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#eab308;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#ca8a04;stop-opacity:1" />
                  </linearGradient>
                  <linearGradient id="depth3" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#22c55e;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#16a34a;stop-opacity:1" />
                  </linearGradient>
                  <linearGradient id="depth4" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#2563eb;stop-opacity:1" />
                  </linearGradient>
                </defs>
                
                <!-- Depth 레이블 및 구분선 (세로선) -->
                ${Array.from({length: maxDepth + 1}, (_, depth) => `
                  <g>
                    <line x1="${150 + depth * 280 - 50}" y1="0" x2="${150 + depth * 280 - 50}" y2="${svgHeight}" 
                          stroke="#e5e7eb" stroke-width="1" stroke-dasharray="5,5" opacity="0.5" />
                    <rect x="${150 + depth * 280 - 90}" y="20" width="80" height="25" 
                          fill="rgba(255,255,255,0.9)" stroke="#d1d5db" rx="12" />
                    <text x="${150 + depth * 280 - 50}" y="37" 
                          text-anchor="middle" 
                          fill="#374151" 
                          font-size="12" 
                          font-weight="600">
                      Depth ${depth}
                    </text>
                  </g>
                `).join('')}
                
                <!-- 연결선 -->
                ${networkData.edges.map(edge => {
                  const fromNode = nodes.find(n => n.id === edge.from)
                  const toNode = nodes.find(n => n.id === edge.to)
                  if (!fromNode || !toNode) return ''
                  
                  return `
                    <line x1="${fromNode.x + 35}" y1="${fromNode.y}" x2="${toNode.x - 35}" y2="${toNode.y}" 
                          stroke="#94a3b8" stroke-width="2" marker-end="url(#arrowhead)" opacity="0.6" />
                  `
                }).join('')}
                
                <!-- 노드 -->
                ${nodes.map((node, index) => {
                  const depthColor = `depth${Math.min(node.depth, 4)}`
                  return `
                    <g class="node-group" data-id="${node.id}" style="cursor: pointer;" 
                       onmouseover="this.style.transform='scale(1.1)'" 
                       onmouseout="this.style.transform='scale(1)'">
                      <circle cx="${node.x}" cy="${node.y}" r="35" 
                              fill="url(#${depthColor})" 
                              stroke="#ffffff" 
                              stroke-width="3" 
                              filter="url(#drop-shadow)" />
                      <text x="${node.x}" y="${node.y - 8}" 
                            text-anchor="middle" 
                            fill="white" 
                            font-size="10" 
                            font-weight="bold">
                        ${node.type}
                      </text>
                      <text x="${node.x}" y="${node.y + 6}" 
                            text-anchor="middle" 
                            fill="white" 
                            font-size="8">
                        D${node.depth}
                      </text>
                      <text x="${node.x}" y="${node.y + 55}" 
                            text-anchor="middle" 
                            fill="#374151" 
                            font-size="10" 
                            font-weight="500"
                            style="max-width: 120px;">
                        ${node.label.length > 20 ? node.label.substring(0, 20) + '...' : node.label}
                      </text>
                    </g>
                  `
                }).join('')}
              </svg>
            </div>
          </div>
        </div>
        
        <!-- 고정된 분석 섹션 -->
        <div class="mt-4 bg-white border rounded-lg p-4">
          <h4 class="font-semibold text-gray-900 mb-3">분석 통계</h4>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="bg-gray-50 p-4 rounded">
              <h5 class="font-medium text-gray-900 mb-2">계층 통계</h5>
              <div class="space-y-1 text-sm text-gray-700">
                <div>최대 깊이: ${maxDepth}단계</div>
                <div>총 노드: ${nodes.length}개</div>
                <div>총 연결: ${networkData.edges.length}개</div>
              </div>
            </div>
            
            <div class="bg-gray-50 p-4 rounded">
              <h5 class="font-medium text-gray-900 mb-2">Depth별 분포</h5>
              <div class="space-y-1 text-sm">
                ${Object.entries(nodesByDepth).map(([depth, depthNodes]) => `
                  <div class="flex items-center justify-between">
                    <span class="text-gray-700">Depth ${depth}:</span>
                    <span class="font-medium">${depthNodes.length}개</span>
                  </div>
                `).join('')}
              </div>
            </div>
            
            <div class="bg-gray-50 p-4 rounded">
              <h5 class="font-medium text-gray-900 mb-2">페이지 유형</h5>
              <div class="space-y-1 text-sm">
                ${Object.entries(nodes.reduce((acc, node) => {
                  acc[node.type] = (acc[node.type] || 0) + 1
                  return acc
                }, {} as Record<string, number>)).map(([type, count]) => `
                  <div class="flex items-center justify-between">
                    <span class="text-gray-700">${type}:</span>
                    <span class="font-medium">${count}개</span>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
          
          <!-- Depth별 색상 범례 -->
          <div class="mt-4 pt-4 border-t">
            <h5 class="font-medium text-gray-900 mb-2">Depth 색상 범례</h5>
            <div class="flex flex-wrap gap-3">
              ${Array.from({length: maxDepth + 1}, (_, i) => `
                <div class="flex items-center gap-2">
                  <div class="w-4 h-4 rounded" style="background: linear-gradient(135deg, 
                    ${i === 0 ? '#ef4444, #dc2626' : 
                      i === 1 ? '#f97316, #ea580c' : 
                      i === 2 ? '#eab308, #ca8a04' : 
                      i === 3 ? '#22c55e, #16a34a' : 
                      '#3b82f6, #2563eb'}
                  )"></div>
                  <span class="text-sm text-gray-700">Depth ${i} (${nodesByDepth[i]?.length || 0}개)</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `
      
      // 확대/축소/리셋 버튼 이벤트
      const zoomInBtn = container.querySelector('#zoom-in')
      const zoomOutBtn = container.querySelector('#zoom-out')
      const resetBtn = container.querySelector('#reset-view')
      const svg = container.querySelector('#network-svg') as SVGElement
      const viewport = container.querySelector('#network-viewport') as HTMLElement
      
      const updateZoom = (newZoom: number) => {
        const clampedZoom = Math.max(0.1, Math.min(3, newZoom))
        setZoom(clampedZoom)
        if (svg) {
          svg.style.transform = `scale(${clampedZoom}) translate(${panX}px, ${panY}px)`
        }
        // 줌 퍼센트 업데이트
        const zoomText = container.querySelector('.text-sm.text-gray-600')
        if (zoomText) {
          zoomText.textContent = `${Math.round(clampedZoom * 100)}%`
        }
      }
      
      zoomInBtn?.addEventListener('click', () => updateZoom(zoom * 1.2))
      zoomOutBtn?.addEventListener('click', () => updateZoom(zoom / 1.2))
      resetBtn?.addEventListener('click', () => {
        setZoom(1)
        setPanX(0)
        setPanY(0)
        updateZoom(1)
        if (svg) {
          svg.style.transform = 'scale(1) translate(0px, 0px)'
        }
        if (viewport) {
          viewport.scrollLeft = 0
          viewport.scrollTop = 0
        }
      })
      
      // 드래그 이벤트 (팬)
      let isDraggingLocal = false
      let dragStartLocal = { x: 0, y: 0 }
      
      viewport?.addEventListener('mousedown', (e) => {
        isDraggingLocal = true
        dragStartLocal = { x: e.clientX - panX, y: e.clientY - panY }
        viewport.style.cursor = 'grabbing'
      })
      
      viewport?.addEventListener('mousemove', (e) => {
        if (!isDraggingLocal) return
        e.preventDefault()
        const newPanX = e.clientX - dragStartLocal.x
        const newPanY = e.clientY - dragStartLocal.y
        setPanX(newPanX)
        setPanY(newPanY)
        if (svg) {
          svg.style.transform = `scale(${zoom}) translate(${newPanX}px, ${newPanY}px)`
        }
      })
      
      viewport?.addEventListener('mouseup', () => {
        isDraggingLocal = false
        viewport.style.cursor = 'grab'
      })
      
      viewport?.addEventListener('mouseleave', () => {
        isDraggingLocal = false
        viewport.style.cursor = 'grab'
      })
      
      // 휠 줌
      viewport?.addEventListener('wheel', (e) => {
        e.preventDefault()
        const delta = e.deltaY > 0 ? 0.9 : 1.1
        updateZoom(zoom * delta)
      })
      
      // 노드 클릭 이벤트 추가
      const nodeGroups = container.querySelectorAll('.node-group')
      nodeGroups.forEach(nodeGroup => {
        nodeGroup.addEventListener('click', (e) => {
          const nodeId = (e.currentTarget as HTMLElement).getAttribute('data-id')
          const clickedNode = networkData.nodes.find(n => n.id === nodeId)
          if (clickedNode) {
            console.log('Clicked node:', clickedNode)
            // 여기에 노드 클릭 시 추가 동작을 구현할 수 있습니다
          }
        })
      })
      
    }, [networkData, zoom, panX, panY])

    return (
      <div className="w-full">
        <div id="network-container" className="w-full"></div>
      </div>
    )
  }

  if (!url) {
    return null
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md shadow-sm border-b border-white/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <Link href="/" className="flex items-center">
              <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl flex items-center justify-center mr-3">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
                AI WebCrawler
              </h1>
            </Link>
            <div className="flex space-x-3">
              <Link href="/login" className="text-gray-600 hover:text-purple-600 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                Sign In
              </Link>
              <Link href="/signup" className="bg-gradient-to-r from-purple-500 to-blue-500 text-white hover:from-purple-600 hover:to-blue-600 px-6 py-2 rounded-lg text-sm font-medium transition-all shadow-lg hover:shadow-xl">
                Sign Up
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* URL Display */}
        <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-4 mb-6 border border-white/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center flex-1">
              <svg className="w-5 h-5 text-purple-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <span className="text-gray-600 mr-3">Analyzing:</span>
              <span className="font-semibold text-gray-800 break-all">{url}</span>
            </div>
            {stats && (
              <div className="flex items-center space-x-4">
                {isPreview && (
                  <span className="bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full text-sm font-medium">
                    Free Preview (5 pages max)
                  </span>
                )}
                <div className="text-sm text-gray-500">
                  Completed in {stats.analysisTime}s
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-6 mb-6">
            <div className="flex items-center">
              <svg className="w-6 h-6 text-red-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h3 className="text-red-800 font-semibold">Analysis Failed</h3>
                <p className="text-red-700">{error}</p>
              </div>
            </div>
            <button 
              onClick={startAnalysis}
              className="mt-4 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {isCheckingAuth || isAnalyzing ? (
          /* Authentication check or Analysis in progress */
          <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl p-12 text-center border border-white/20">
            <div className="mb-8">
              <div className="w-24 h-24 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
                <svg className="w-12 h-12 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <h2 className="text-3xl font-bold text-gray-800 mb-4">
                {isCheckingAuth ? 'Verifying Your Access' : 'AI is analyzing the website'}
              </h2>
              <p className="text-lg text-gray-600 mb-8">
                {isCheckingAuth 
                  ? 'Checking your login status...' 
                  : 'Please wait while we map the site structure...'
                }
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-4 mb-4">
              <div 
                className="bg-gradient-to-r from-purple-500 to-blue-500 h-4 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <p className="text-gray-500">{Math.round(progress)}% complete</p>

            {/* Analysis steps */}
            <div className="mt-12 grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="text-center">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-700">Loading Page</p>
              </div>
              <div className="text-center">
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3 animate-pulse">
                  <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-1.447-.894L15 9m0 8V9m0 0H9" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-700">Mapping Structure</p>
              </div>
              <div className="text-center">
                <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-3 animate-pulse">
                  <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-700">Extracting Data</p>
              </div>
              <div className="text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-700">Generating Report</p>
              </div>
            </div>
          </div>
        ) : (
          /* Analysis results dashboard */
          <div className="grid grid-cols-12 gap-6">
            {/* Stats Cards */}
            <div className="col-span-12 grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-4 border border-white/20">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl flex items-center justify-center mr-3">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-800">{stats?.totalPages}</p>
                    <p className="text-sm text-gray-600">Pages</p>
                  </div>
                </div>
              </div>

              <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-4 border border-white/20">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl flex items-center justify-center mr-3">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-800">{stats?.totalImages}</p>
                    <p className="text-sm text-gray-600">Images</p>
                  </div>
                </div>
              </div>

              <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-4 border border-white/20">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl flex items-center justify-center mr-3">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-800">{stats?.totalLinks}</p>
                    <p className="text-sm text-gray-600">Links</p>
                  </div>
                </div>
              </div>

              <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-4 border border-white/20">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl flex items-center justify-center mr-3">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-800">{stats?.totalWords.toLocaleString()}</p>
                    <p className="text-sm text-gray-600">Words</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Site Structure Map - Left Side */}
            <div className="col-span-12 lg:col-span-5">
              <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl border border-white/20 h-[600px]">
                <div className="p-6 border-b border-gray-200">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-gray-800">
                      {viewMode === 'structure' ? 'Site Structure Map' : 'Network Map'}
                    </h3>
                    <button
                      onClick={() => handleDownload()}
                      className="bg-gradient-to-r from-purple-500 to-blue-500 text-white text-sm font-medium py-2 px-4 rounded-xl hover:from-purple-600 hover:to-blue-600 transition-all shadow-lg hover:shadow-xl"
                    >
                      Export Data
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setViewMode('structure')}
                      className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm ${
                        viewMode === 'structure'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      📋 Structure Map
                    </button>
                    <button
                      onClick={() => setViewMode('network')}
                      className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm ${
                        viewMode === 'network'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      🌐 Network Map
                    </button>
                  </div>
                </div>
                <div className="p-4 overflow-y-auto h-[520px]">
                  {viewMode === 'structure' ? (
                    <div>
                      {siteMap.map(node => renderTreeNode(node))}
                    </div>
                  ) : (
                    <div className="h-full">
                      {result && result.networkData ? (
                        <NetworkVisualization networkData={result.networkData} />
                      ) : (
                        <div className="flex items-center justify-center h-full text-gray-500">
                          네트워크 데이터를 로드하는 중...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Page Preview - Right Side */}
            <div className="col-span-12 lg:col-span-7">
              <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl border border-white/20 h-[600px]">
                <div className="p-6 border-b border-gray-200">
                  <h3 className="text-xl font-bold text-gray-800">Page Details</h3>
                  {selectedNode && (
                    <p className="text-sm text-gray-600 mt-1">{selectedNode.url}</p>
                  )}
                </div>
                <div className="p-6 overflow-y-auto h-[520px]">
                  {selectedNode ? (
                    <div className="space-y-6">
                      {/* Page Screenshot */}
                      <div className="bg-gray-100 rounded-2xl p-4 border-2 border-dashed border-gray-300">
                        <div className="text-center">
                          {loadingPageDetails ? (
                            <div className="py-12">
                              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
                              <p className="text-gray-600">페이지 상세 정보를 불러오는 중...</p>
                            </div>
                          ) : selectedNode.screenshotPath || pageDetailsCache[selectedNode.url]?.screenshotPath ? (
                            <div className="relative">
                              {(() => {
                                const locked = isPreview && result && result.results.findIndex(r => r.id === selectedNode.id) >= (result?.previewLimit || 5)
                                return (
                                  <>
                                    <img
                                      src={getScreenshotUrl(selectedNode.screenshotPath || pageDetailsCache[selectedNode.url]?.screenshotPath)}
                                      alt={`Screenshot of ${selectedNode.title}`}
                                      className={`w-full max-h-96 object-contain rounded-lg mb-4 ${locked ? 'filter blur-sm opacity-50' : ''}`}
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none'
                                        const nextElement = e.currentTarget.nextElementSibling as HTMLElement
                                        if (nextElement) nextElement.style.display = 'block'
                                      }}
                                    />
                                    {locked && (
                                      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                                        <div className="bg-white/80 backdrop-blur-lg p-4 rounded-xl shadow-lg">
                                          <p className="font-semibold text-gray-800 mb-2">Premium Screenshot</p>
                                          <p className="text-gray-600 text-sm mb-4">Sign up to view full-resolution image</p>
                                          <Link href="/signup" className="inline-block bg-gradient-to-r from-purple-500 to-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:from-purple-600 hover:to-blue-600">Sign Up</Link>
                                        </div>
                                      </div>
                                    )}
                                  </>
                                )
                              })()}
                              
                              <div style={{ display: 'none' }}>
                                <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                <p className="text-gray-500">Screenshot not available</p>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                              <h4 className="text-lg font-semibold text-gray-700 mb-2">Page Screenshot</h4>
                              <p className="text-gray-500">Visual preview of {selectedNode.title}</p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Get Details Buttons */}
                      <div className="flex space-x-3">
                        <button
                          onClick={() => handleNodeClick(selectedNode)}
                          disabled={loadingPageDetails || selectedNode.screenshotPath || pageDetailsCache[selectedNode.url]}
                          className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold py-3 px-4 rounded-xl hover:from-blue-600 hover:to-cyan-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          {selectedNode.screenshotPath || pageDetailsCache[selectedNode.url] ? 'PNG Ready' : 'Get PNG'}
                        </button>
                        <button
                          onClick={() => handleNodeClick(selectedNode)}
                          disabled={loadingPageDetails || selectedNode.htmlPath || pageDetailsCache[selectedNode.url]}
                          className="flex-1 bg-gradient-to-r from-green-500 to-emerald-500 text-white font-semibold py-3 px-4 rounded-xl hover:from-green-600 hover:to-emerald-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          {selectedNode.htmlPath || pageDetailsCache[selectedNode.url] ? 'HTML Ready' : 'Get HTML'}
                        </button>
                      </div>

                      {/* Page Metadata */}
                      {selectedNode.metadata && (
                        <div className="bg-gray-50 rounded-2xl p-6">
                          <h4 className="text-lg font-semibold text-gray-800 mb-4">Page Information</h4>
                          <div className="space-y-4">
                            <div>
                              <label className="text-sm font-medium text-gray-600">Title</label>
                              <p className="text-gray-800 font-medium">{selectedNode.metadata.title}</p>
                            </div>
                            <div>
                              <label className="text-sm font-medium text-gray-600">Description</label>
                              <p className="text-gray-800">{selectedNode.metadata.description}</p>
                            </div>
                            <div className="grid grid-cols-3 gap-4">
                              <div className="text-center p-3 bg-white rounded-xl">
                                <p className="text-lg font-bold text-blue-600">{selectedNode.metadata.images}</p>
                                <p className="text-xs text-gray-600">Images</p>
                              </div>
                              <div className="text-center p-3 bg-white rounded-xl">
                                <p className="text-lg font-bold text-purple-600">{selectedNode.metadata.links}</p>
                                <p className="text-xs text-gray-600">Links</p>
                              </div>
                              <div className="text-center p-3 bg-white rounded-xl">
                                <p className="text-lg font-bold text-green-600">{selectedNode.metadata.wordCount}</p>
                                <p className="text-xs text-gray-600">Words</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                      <p className="text-gray-500">Select a page from the structure map to view details</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="col-span-12 text-center mt-6">
              <div className="flex flex-wrap justify-center gap-4">
                <Link 
                  href="/"
                  className="inline-flex items-center bg-white/90 backdrop-blur-lg text-purple-600 font-semibold py-3 px-6 rounded-2xl hover:bg-white transition-all duration-300 shadow-lg hover:shadow-xl border border-white/20"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Analyze Another Website
                </Link>
                <button
                  onClick={() => handleDownload()}
                  className="bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold py-3 px-6 rounded-2xl hover:from-purple-600 hover:to-blue-600 transition-all duration-300 shadow-lg hover:shadow-xl"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download Full Report
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Signup Modal */}
      {showSignupModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="text-2xl font-bold text-gray-800 mb-2">Sign up to download</h3>
              <p className="text-gray-600">Create a free account to access all data and reports!</p>
            </div>
            
            <div className="space-y-3">
              <Link 
                href="/signup"
                className="w-full bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold py-4 px-6 rounded-xl hover:from-purple-600 hover:to-blue-600 transition-all duration-300 shadow-lg hover:shadow-xl block text-center"
              >
                Create Free Account
              </Link>
              <Link 
                href="/login"
                className="w-full bg-gray-100 text-gray-700 font-semibold py-4 px-6 rounded-xl hover:bg-gray-200 transition-all duration-300 block text-center"
              >
                I already have an account
              </Link>
              <button 
                onClick={() => setShowSignupModal(false)}
                className="w-full text-gray-500 py-2 hover:text-gray-700 transition-colors"
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
} 