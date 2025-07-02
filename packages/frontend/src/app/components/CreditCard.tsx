'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface CreditBalance {
  credits: number
  totalCreditsEarned: number
  totalCreditsUsed: number
}

export default function CreditCard() {
  const router = useRouter()
  const [creditBalance, setCreditBalance] = useState<CreditBalance | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchCreditBalance()
  }, [])

  const fetchCreditBalance = async () => {
    try {
      const token = localStorage.getItem('token')
      if (!token) return

      const response = await fetch('/api/credits/balance', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const data = await response.json()
        setCreditBalance(data)
      }
    } catch (error) {
      console.error('Failed to fetch credit balance:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-3"></div>
          <div className="h-6 bg-gray-200 rounded w-1/2 mb-2"></div>
          <div className="h-3 bg-gray-200 rounded w-2/3"></div>
        </div>
      </div>
    )
  }

  if (!creditBalance) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-800 mb-1">💰 크레딧</h3>
            <p className="text-sm text-red-500">정보를 불러올 수 없습니다</p>
          </div>
          <Link
            href="/dashboard/credits"
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
          >
            관리
          </Link>
        </div>
      </div>
    )
  }

  const remainingPages = Math.floor(creditBalance.credits / 10)
  const dollarsSpent = (creditBalance.totalCreditsEarned / 100).toFixed(2)
  
  // 크레딧 부족 여부 확인 (100크레딧 미만)
  const isLowCredit = creditBalance.credits < 100

  return (
    <div className={`bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border transition-all duration-300 ${
      isLowCredit ? 'border-red-200 bg-red-50/50' : 'border-white/20'
    }`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-800 flex items-center">
          💰 크레딧 잔액
          {isLowCredit && (
            <span className="ml-2 bg-red-100 text-red-600 text-xs px-2 py-1 rounded-full">
              부족
            </span>
          )}
        </h3>
        <Link
          href="/dashboard/credits"
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg font-medium transition-colors text-sm"
        >
          관리
        </Link>
      </div>

      <div className="space-y-3">
        {/* 현재 크레딧 */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">보유 크레딧</span>
          <div className="text-right">
            <div className={`text-lg font-bold ${isLowCredit ? 'text-red-600' : 'text-gray-800'}`}>
              {creditBalance.credits.toLocaleString()}
            </div>
            <div className="text-xs text-gray-500">
              약 {remainingPages}페이지 분석 가능
            </div>
          </div>
        </div>

        {/* 총 결제 금액 */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">총 결제금액</span>
          <div className="text-right">
            <div className="text-sm font-medium text-green-600">
              ${dollarsSpent}
            </div>
            <div className="text-xs text-gray-500">
              {creditBalance.totalCreditsEarned.toLocaleString()} 크레딧 구매
            </div>
          </div>
        </div>

        {/* 사용된 크레딧 */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">사용한 크레딧</span>
          <div className="text-right">
            <div className="text-sm font-medium text-gray-700">
              {creditBalance.totalCreditsUsed.toLocaleString()}
            </div>
            <div className="text-xs text-gray-500">
              약 {Math.floor(creditBalance.totalCreditsUsed / 10)}페이지 분석
            </div>
          </div>
        </div>
      </div>

      {/* 크레딧 부족 경고 */}
      {isLowCredit && (
        <div className="mt-4 p-3 bg-red-100 border border-red-200 rounded-lg">
          <div className="flex items-center text-red-700 text-sm">
            <svg className="w-4 h-4 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            크레딧이 부족합니다. 추가 분석을 위해 크레딧을 구매해주세요.
          </div>
        </div>
      )}

      {/* 가격 정보 */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="text-xs text-gray-500 space-y-1">
          <div>• 10페이지 = 100크레딧 = $1</div>
          <div>• 1페이지 = 10크레딧 = $0.1</div>
        </div>
      </div>
    </div>
  )
} 