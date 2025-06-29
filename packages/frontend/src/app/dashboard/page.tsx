'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface CrawlResult {
  id: string
  url: string
  status: string
  createdAt: string
  completedAt?: string
}

export default function Dashboard() {
  const [url, setUrl] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [results, setResults] = useState<CrawlResult[]>([])
  const [user, setUser] = useState<any>(null)
  const router = useRouter()

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    // 사용자 정보 가져오기
    fetchUserProfile()
    fetchCrawlHistory()
  }, [])

  const fetchUserProfile = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/auth/profile', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const userData = await response.json()
        setUser(userData)
      } else {
        localStorage.removeItem('token')
        router.push('/login')
      }
    } catch (error) {
      console.error('Failed to fetch user profile:', error)
    }
  }

  const fetchCrawlHistory = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/crawler/history', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setResults(data)
      }
    } catch (error) {
      console.error('Failed to fetch crawl history:', error)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('http://localhost:3000/crawler/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ url }),
      })

      if (response.ok) {
        const result = await response.json()
        setResults([result, ...results])
        setUrl('')
        alert('크롤링이 시작되었습니다!')
      } else {
        alert('크롤링 요청에 실패했습니다.')
      }
    } catch (error) {
      alert('네트워크 오류가 발생했습니다.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    router.push('/')
  }

  const getStatusBadge = (status: string) => {
    const baseClasses = "px-2 inline-flex text-xs leading-5 font-semibold rounded-full"
    switch (status) {
      case 'completed':
        return `${baseClasses} bg-green-100 text-green-800`
      case 'processing':
        return `${baseClasses} bg-yellow-100 text-yellow-800`
      case 'failed':
        return `${baseClasses} bg-red-100 text-red-800`
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed':
        return '완료'
      case 'processing':
        return '진행중'
      case 'failed':
        return '실패'
      default:
        return '대기'
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <h1 className="text-3xl font-bold text-gray-900">대시보드</h1>
            <div className="flex items-center space-x-4">
              {user && (
                <span className="text-gray-700">안녕하세요, {user.name}님</span>
              )}
              <button
                onClick={handleLogout}
                className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700"
              >
                로그아웃
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* 새 크롤링 요청 */}
        <div className="px-4 py-6 sm:px-0">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                새 웹사이트 크롤링
              </h3>
              <form onSubmit={handleSubmit}>
                <div className="flex gap-4">
                  <input
                    type="url"
                    required
                    className="flex-1 border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    placeholder="크롤링할 웹사이트 URL을 입력하세요 (예: https://example.com)"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="bg-blue-600 text-white px-6 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isLoading ? '분석 중...' : '크롤링 시작'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        {/* 크롤링 결과 목록 */}
        <div className="px-4 py-6 sm:px-0">
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <div className="px-4 py-5 sm:px-6">
              <h3 className="text-lg leading-6 font-medium text-gray-900">
                크롤링 기록
              </h3>
              <p className="mt-1 max-w-2xl text-sm text-gray-500">
                최근 크롤링 요청과 결과를 확인하세요.
              </p>
            </div>
            <ul className="divide-y divide-gray-200">
              {results.length === 0 ? (
                <li className="px-4 py-4 text-center text-gray-500">
                  아직 크롤링 기록이 없습니다.
                </li>
              ) : (
                results.map((result) => (
                  <li key={result.id} className="px-4 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {result.url}
                        </p>
                        <p className="text-sm text-gray-500">
                          시작: {new Date(result.createdAt).toLocaleString('ko-KR')}
                          {result.completedAt && (
                            <span className="ml-4">
                              완료: {new Date(result.completedAt).toLocaleString('ko-KR')}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center space-x-4">
                        <span className={getStatusBadge(result.status)}>
                          {getStatusText(result.status)}
                        </span>
                        {result.status === 'completed' && (
                          <button className="text-blue-600 hover:text-blue-900 text-sm font-medium">
                            결과 보기
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </main>
    </div>
  )
} 