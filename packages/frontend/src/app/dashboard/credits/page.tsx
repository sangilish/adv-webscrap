'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import CreditBalance from '../../components/CreditBalance'
import CreditPurchase from '../../components/CreditPurchase'

export default function CreditsDashboard() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    // URL 파라미터에서 결제 결과 확인
    const urlParams = new URLSearchParams(window.location.search)
    const success = urlParams.get('success')
    const canceled = urlParams.get('canceled')
    const sessionId = urlParams.get('session_id')

    if (success === 'true') {
      setPaymentStatus('success')
      // URL 파라미터 제거
      window.history.replaceState({}, '', '/dashboard/credits')
    } else if (canceled === 'true') {
      setPaymentStatus('canceled')
      // URL 파라미터 제거
      window.history.replaceState({}, '', '/dashboard/credits')
    }

    setLoading(false)
  }, [router])

  const logout = () => {
    localStorage.removeItem('token')
    router.push('/')
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
          <h2 className="text-2xl font-bold text-gray-800 mb-4">Loading Credits</h2>
          <p className="text-gray-600">Please wait...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white/90 backdrop-blur-lg shadow-lg border-b border-white/20 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-4">
              <Link href="/dashboard" className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
                WebAnalyzer
              </Link>
              <nav className="hidden md:flex space-x-6">
                <Link href="/dashboard" className="text-gray-600 hover:text-purple-600 font-medium transition-colors">
                  대시보드
                </Link>
                <Link href="/dashboard/credits" className="text-purple-600 font-medium border-b-2 border-purple-600 pb-1">
                  크레딧
                </Link>
              </nav>
            </div>

            <div className="flex items-center space-x-4">
              <button
                onClick={logout}
                className="text-gray-600 hover:text-red-600 font-medium transition-colors"
              >
                로그아웃
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">💳 크레딧 관리</h1>
          <p className="text-gray-600">
            크레딧을 관리하고, 더 많은 페이지를 분석하기 위해 크레딧을 구매하세요.
          </p>
        </div>

        <div className="space-y-8">
          {/* 결제 상태 알림 */}
          {paymentStatus === 'success' && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4">
              <div className="flex items-center">
                <svg className="w-5 h-5 text-green-600 mr-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="text-green-800 font-medium">결제가 완료되었습니다! 🎉</h3>
                  <p className="text-green-700 text-sm">크레딧이 계정에 추가되었습니다. 이제 더 많은 페이지를 분석할 수 있습니다.</p>
                </div>
              </div>
            </div>
          )}

          {paymentStatus === 'canceled' && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
              <div className="flex items-center">
                <svg className="w-5 h-5 text-yellow-600 mr-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="text-yellow-800 font-medium">결제가 취소되었습니다</h3>
                  <p className="text-yellow-700 text-sm">언제든지 다시 크레딧을 구매하실 수 있습니다.</p>
                </div>
              </div>
            </div>
          )}

          {/* 크레딧 잔액 */}
          <CreditBalance />

          {/* 크레딧 구매 */}
          <CreditPurchase />

          {/* 추가 정보 */}
          <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
            <h2 className="text-xl font-bold text-gray-800 mb-4">📋 자주 묻는 질문</h2>
            <div className="space-y-4">
              <div className="border-b border-gray-200 pb-4">
                <h3 className="font-semibold text-gray-700 mb-2">Q. 크레딧은 언제 만료되나요?</h3>
                <p className="text-gray-600 text-sm">
                  A. 크레딧은 만료되지 않습니다. 구매한 크레딧은 계정에서 언제든지 사용할 수 있습니다.
                </p>
              </div>
              
              <div className="border-b border-gray-200 pb-4">
                <h3 className="font-semibold text-gray-700 mb-2">Q. 페이지별 크레딧 소모량은 어떻게 되나요?</h3>
                <p className="text-gray-600 text-sm">
                  A. 1페이지 분석당 10크레딧이 소모됩니다. 즉, 100크레딧으로 10페이지를 분석할 수 있습니다.
                </p>
              </div>
              
              <div className="border-b border-gray-200 pb-4">
                <h3 className="font-semibent text-gray-700 mb-2">Q. 환불이 가능한가요?</h3>
                <p className="text-gray-600 text-sm">
                  A. 구매 후 7일 이내, 크레딧을 사용하지 않은 경우에 한해 환불이 가능합니다. 
                  자세한 내용은 이용약관을 확인해주세요.
                </p>
              </div>
              
              <div>
                <h3 className="font-semibold text-gray-700 mb-2">Q. 대량 구매 할인이 있나요?</h3>
                <p className="text-gray-600 text-sm">
                  A. 네! Standard 이상의 패키지에서는 보너스 크레딧을 제공합니다. 더 많이 구매할수록 더 많은 혜택을 받으실 수 있습니다.
                </p>
              </div>
            </div>
          </div>

          {/* 지원 문의 */}
          <div className="bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl shadow-xl p-6 text-white">
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold mb-1">도움이 필요하신가요?</h3>
                <p className="text-white/90 text-sm">
                  크레딧 관련 문의사항이나 결제 문제가 있으시면 언제든지 연락주세요.
                </p>
              </div>
              <button className="bg-white/20 hover:bg-white/30 px-6 py-3 rounded-lg font-medium transition-colors">
                문의하기
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
} 