'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface CreditTransaction {
  id: string
  type: string
  amount: number
  balanceAfter: number
  description: string | null
  createdAt: string
}

interface CreditBalance {
  credits: number
  totalCreditsEarned: number
  totalCreditsUsed: number
  recentTransactions: CreditTransaction[]
}

export default function CreditBalance() {
  const router = useRouter()
  const [creditBalance, setCreditBalance] = useState<CreditBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [showTransactions, setShowTransactions] = useState(false)

  useEffect(() => {
    fetchCreditBalance()
  }, [])

  const fetchCreditBalance = async () => {
    try {
      const token = localStorage.getItem('token')
      if (!token) {
        router.push('/login')
        return
      }

      const response = await fetch('/api/credits/balance', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const data = await response.json()
        setCreditBalance(data)
      } else if (response.status === 401) {
        localStorage.removeItem('token')
        router.push('/login')
      }
    } catch (error) {
      console.error('Failed to fetch credit balance:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatAmount = (amount: number) => {
    return amount > 0 ? `+${amount}` : amount.toString()
  }

  const getTransactionColor = (type: string) => {
    switch (type) {
      case 'purchase':
      case 'bonus':
        return 'text-green-600'
      case 'usage':
        return 'text-red-600'
      case 'refund':
        return 'text-blue-600'
      default:
        return 'text-gray-600'
    }
  }

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'purchase':
        return '💳'
      case 'usage':
        return '📄'
      case 'bonus':
        return '🎁'
      case 'refund':
        return '↩️'
      default:
        return '•'
    }
  }

  if (loading) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-1/3 mb-4"></div>
          <div className="h-8 bg-gray-200 rounded w-1/2 mb-2"></div>
          <div className="h-4 bg-gray-200 rounded w-2/3"></div>
        </div>
      </div>
    )
  }

  if (!creditBalance) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <p className="text-red-500">크레딧 정보를 불러오는데 실패했습니다.</p>
      </div>
    )
  }

  const remainingPages = Math.floor(creditBalance.credits / 10)
  const dollarsSpent = (creditBalance.totalCreditsEarned / 100).toFixed(2)

  return (
    <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-800 flex items-center">
          💰 크레딧 잔액
        </h2>
        <button
          onClick={() => setShowTransactions(!showTransactions)}
          className="text-blue-600 hover:text-blue-700 text-sm font-medium"
        >
          거래내역 {showTransactions ? '숨기기' : '보기'}
        </button>
      </div>

      {/* 크레딧 정보 카드들 */}
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {/* 현재 크레딧 */}
        <div className="bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl p-4 text-white">
          <div className="text-sm opacity-90 mb-1">보유 크레딧</div>
          <div className="text-2xl font-bold">{creditBalance.credits.toLocaleString()}</div>
          <div className="text-xs opacity-75">약 {remainingPages}페이지 분석 가능</div>
        </div>

        {/* 총 구매 금액 */}
        <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-xl p-4 text-white">
          <div className="text-sm opacity-90 mb-1">총 결제금액</div>
          <div className="text-2xl font-bold">${dollarsSpent}</div>
          <div className="text-xs opacity-75">{creditBalance.totalCreditsEarned.toLocaleString()} 크레딧 구매</div>
        </div>

        {/* 총 사용 크레딧 */}
        <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-xl p-4 text-white">
          <div className="text-sm opacity-90 mb-1">사용한 크레딧</div>
          <div className="text-2xl font-bold">{creditBalance.totalCreditsUsed.toLocaleString()}</div>
          <div className="text-xs opacity-75">약 {Math.floor(creditBalance.totalCreditsUsed / 10)}페이지 분석</div>
        </div>
      </div>

      {/* 가격 정보 */}
      <div className="bg-gray-50 rounded-lg p-4 mb-6">
        <h3 className="font-semibold text-gray-700 mb-2">💡 가격 정보</h3>
        <div className="text-sm text-gray-600 space-y-1">
          <div>• 10페이지 분석 = 100크레딧 = $1</div>
          <div>• 1페이지 분석 = 10크레딧 = $0.1</div>
          <div>• 크레딧은 만료되지 않습니다</div>
        </div>
      </div>

      {/* 거래 내역 */}
      {showTransactions && (
        <div className="border-t pt-4">
          <h3 className="font-semibold text-gray-700 mb-3">최근 거래 내역</h3>
          {creditBalance.recentTransactions.length === 0 ? (
            <p className="text-gray-500 text-sm">거래 내역이 없습니다.</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {creditBalance.recentTransactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="flex items-center space-x-3">
                    <span className="text-lg">{getTransactionIcon(transaction.type)}</span>
                    <div>
                      <div className="text-sm font-medium text-gray-800">
                        {transaction.description || '거래'}
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(transaction.createdAt).toLocaleDateString('ko-KR')}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-sm font-bold ${getTransactionColor(transaction.type)}`}>
                      {formatAmount(transaction.amount)}
                    </div>
                    <div className="text-xs text-gray-500">
                      잔액: {transaction.balanceAfter}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
} 