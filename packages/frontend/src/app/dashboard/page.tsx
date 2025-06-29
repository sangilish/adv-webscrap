'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface UserAnalysis {
  id: string
  url: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  pageCount: number
  progress: number
  createdAt: string
  updatedAt: string
}

interface UserProfile {
  id: number
  email: string
  plan: 'FREE' | 'PRO' | 'ENTERPRISE'
  freeAnalysisCount: number
  subscriptionType: string
  createdAt: string
}

export default function Dashboard() {
  const router = useRouter()
  const [user, setUser] = useState<UserProfile | null>(null)
  const [analyses, setAnalyses] = useState<UserAnalysis[]>([])
  const [loading, setLoading] = useState(true)
  const [newCrawlUrl, setNewCrawlUrl] = useState('')
  const [maxPages, setMaxPages] = useState(5)
  const [isStartingCrawl, setIsStartingCrawl] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    fetchUserData()
    fetchAnalyses()
  }, [router])

  const fetchUserData = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/auth/profile', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const userData = await response.json()
        setUser(userData)
      } else {
        localStorage.removeItem('token')
        router.push('/login')
      }
    } catch (error) {
      console.error('Failed to fetch user data:', error)
      localStorage.removeItem('token')
      router.push('/login')
    }
  }

  const fetchAnalyses = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/crawler/analyses', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const analysesData = await response.json()
        setAnalyses(analysesData)
      }
    } catch (error) {
      console.error('Failed to fetch analyses:', error)
    } finally {
      setLoading(false)
    }
  }

  const startNewCrawl = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!newCrawlUrl.trim()) return

    try {
      new URL(newCrawlUrl) // URL 유효성 검사
    } catch (error) {
      alert('Please enter a valid URL')
      return
    }

    setIsStartingCrawl(true)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/crawler/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          url: newCrawlUrl,
          maxPages: maxPages
        })
      })

      if (response.ok) {
        const result = await response.json()
        alert('Analysis started successfully!')
        setNewCrawlUrl('')
        fetchAnalyses() // 목록 새로고침
        
        // 분석 페이지로 이동 (실제 분석 ID 사용)
        router.push(`/analyze?url=${encodeURIComponent(newCrawlUrl)}&analysisId=${result.analysisId}`)
      } else {
        const error = await response.json()
        alert(error.message || 'Failed to start analysis')
      }
    } catch (error) {
      console.error('Failed to start crawl:', error)
      alert('Failed to start analysis. Please try again.')
    } finally {
      setIsStartingCrawl(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('token')
    router.push('/')
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-600 bg-green-100'
      case 'running': return 'text-blue-600 bg-blue-100'
      case 'failed': return 'text-red-600 bg-red-100'
      case 'pending': return 'text-yellow-600 bg-yellow-100'
      default: return 'text-gray-600 bg-gray-100'
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed': return 'Completed'
      case 'running': return 'Running'
      case 'failed': return 'Failed'
      case 'pending': return 'Pending'
      default: return 'Unknown'
    }
  }

  const getPlanLimits = (plan: string) => {
    switch (plan) {
      case 'FREE': return { monthly: 10, pages: 5, storage: '5 analyses' }
      case 'PRO': return { monthly: 100, pages: 100, storage: 'Unlimited' }
      case 'ENTERPRISE': return { monthly: 1000, pages: 1000, storage: 'Unlimited' }
      default: return { monthly: 10, pages: 5, storage: '5 analyses' }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl p-12 text-center border border-white/20">
          <div className="w-16 h-16 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
            <svg className="w-8 h-8 text-white animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-4">Loading Dashboard</h2>
          <p className="text-gray-600">Please wait...</p>
        </div>
      </div>
    )
  }

  const limits = user ? getPlanLimits(user.plan) : getPlanLimits('FREE')

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
            <div className="flex items-center space-x-4">
              <div className="text-sm text-gray-600">
                Welcome back, <span className="font-semibold">{user?.email}</span>!
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                user?.plan === 'FREE' ? 'bg-gray-100 text-gray-700' :
                user?.plan === 'PRO' ? 'bg-blue-100 text-blue-700' :
                'bg-purple-100 text-purple-700'
              }`}>
                {user?.plan} Plan
              </div>
              <button
                onClick={logout}
                className="text-gray-600 hover:text-purple-600 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
            <div className="flex items-center">
              <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl flex items-center justify-center mr-4">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-800">{analyses.length}</p>
                <p className="text-sm text-gray-600">Total Analyses</p>
              </div>
            </div>
          </div>

          <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
            <div className="flex items-center">
              <div className="w-12 h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl flex items-center justify-center mr-4">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-800">
                  {analyses.filter(a => a.status === 'completed').length}
                </p>
                <p className="text-sm text-gray-600">Completed</p>
              </div>
            </div>
          </div>

          <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
            <div className="flex items-center">
              <div className="w-12 h-12 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-xl flex items-center justify-center mr-4">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-800">
                  {user?.freeAnalysisCount || 0}/{limits.monthly}
                </p>
                <p className="text-sm text-gray-600">Monthly Usage</p>
              </div>
            </div>
          </div>

          <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
            <div className="flex items-center">
              <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl flex items-center justify-center mr-4">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17v4a2 2 0 002 2h4M13 13h4a2 2 0 012 2v4a2 2 0 01-2 2h-4m-6-4v-2m0-4V7m0 4l4-4" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-800">{limits.pages}</p>
                <p className="text-sm text-gray-600">Pages/Analysis</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* New Analysis Form */}
          <div className="lg:col-span-1">
            <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl border border-white/20 p-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-6">Start New Analysis</h2>
              
              <form onSubmit={startNewCrawl} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Website URL
                  </label>
                  <input
                    type="url"
                    value={newCrawlUrl}
                    onChange={(e) => setNewCrawlUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Max Pages ({user?.plan === 'FREE' ? 'Max 5' : `Max ${limits.pages}`})
                  </label>
                  <select
                    value={maxPages}
                    onChange={(e) => setMaxPages(parseInt(e.target.value))}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  >
                    <option value={5}>5 pages</option>
                    {user?.plan !== 'FREE' && (
                      <>
                        <option value={10}>10 pages</option>
                        <option value={25}>25 pages</option>
                        <option value={50}>50 pages</option>
                        {user?.plan === 'ENTERPRISE' && (
                          <>
                            <option value={100}>100 pages</option>
                            <option value={500}>500 pages</option>
                          </>
                        )}
                      </>
                    )}
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={isStartingCrawl || !newCrawlUrl.trim()}
                  className="w-full bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold py-3 px-6 rounded-xl hover:from-purple-600 hover:to-blue-600 transition-all duration-300 shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isStartingCrawl ? (
                    <div className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Starting Analysis...
                    </div>
                  ) : (
                    'Start Analysis'
                  )}
                </button>
              </form>

              {/* Plan Information */}
              <div className="mt-6 p-4 bg-gray-50 rounded-xl">
                <h3 className="font-semibold text-gray-800 mb-2">Your Plan Limits</h3>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex justify-between">
                    <span>Monthly analyses:</span>
                    <span className="font-medium">{user?.freeAnalysisCount || 0}/{limits.monthly}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Pages per analysis:</span>
                    <span className="font-medium">{limits.pages}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Storage:</span>
                    <span className="font-medium">{limits.storage}</span>
                  </div>
                </div>
                {user?.plan === 'FREE' && (
                  <div className="mt-4">
                    <Link
                      href="/pricing"
                      className="text-purple-600 hover:text-purple-700 text-sm font-medium"
                    >
                      Upgrade to Pro →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Analysis History */}
          <div className="lg:col-span-2">
            <div className="bg-white/90 backdrop-blur-lg rounded-3xl shadow-2xl border border-white/20 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-800">Analysis History</h2>
                <button
                  onClick={fetchAnalyses}
                  className="text-purple-600 hover:text-purple-700 text-sm font-medium"
                >
                  Refresh
                </button>
              </div>

              {analyses.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <h3 className="text-lg font-medium text-gray-800 mb-2">No analyses yet</h3>
                  <p className="text-gray-600">Start your first website analysis to see results here.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {analyses.map((analysis) => (
                    <div key={analysis.id} className="bg-gray-50 rounded-2xl p-4 hover:bg-gray-100 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <h3 className="font-semibold text-gray-800 truncate">
                              {analysis.title || 'Untitled Analysis'}
                            </h3>
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(analysis.status)}`}>
                              {getStatusText(analysis.status)}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600 truncate mb-2">{analysis.url}</p>
                          <div className="flex items-center space-x-4 text-xs text-gray-500">
                            <span>{analysis.pageCount} pages</span>
                            <span>{new Date(analysis.createdAt).toLocaleDateString()}</span>
                            {analysis.status === 'running' && (
                              <span>{analysis.progress}% complete</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          {analysis.status === 'completed' && (
                            <Link
                              href={`/analyze?url=${encodeURIComponent(analysis.url)}&analysisId=${analysis.id}`}
                              className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                            >
                              View Results
                            </Link>
                          )}
                          {analysis.status === 'running' && (
                            <div className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
                              Running...
                            </div>
                          )}
                          {analysis.status === 'failed' && (
                            <button
                              onClick={() => {
                                setNewCrawlUrl(analysis.url)
                                startNewCrawl
                              }}
                              className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      </div>
                      {analysis.status === 'running' && analysis.progress > 0 && (
                        <div className="mt-3">
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div 
                              className="bg-gradient-to-r from-purple-500 to-blue-500 h-2 rounded-full transition-all duration-300"
                              style={{ width: `${analysis.progress}%` }}
                            ></div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
} 