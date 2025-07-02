'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface PricingPackage {
  name: string
  credits: number
  price: number
  pages: number
  popular: boolean
  bonus?: number
}

interface PricingData {
  rates: {
    creditsPerDollar: number
    creditsPerPage: number
    pagesPerDollar: number
  }
  packages: PricingPackage[]
}

export default function CreditPurchase() {
  const router = useRouter()
  const [pricingData, setPricingData] = useState<PricingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [customCredits, setCustomCredits] = useState<number>(100)

  useEffect(() => {
    fetchPricingData()
  }, [])

  const fetchPricingData = async () => {
    try {
      const token = localStorage.getItem('token')
      if (!token) {
        router.push('/login')
        return
      }

      const response = await fetch('/api/credits/pricing', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const data = await response.json()
        setPricingData(data)
      } else if (response.status === 401) {
        localStorage.removeItem('token')
        router.push('/login')
      }
    } catch (error) {
      console.error('Failed to fetch pricing data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handlePackagePurchase = async (pkg: PricingPackage) => {
    try {
      const totalCredits = pkg.credits + (pkg.bonus || 0);
      
      // 결제 세션 생성
      const token = localStorage.getItem('token');
      const response = await fetch('/api/payments/create-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ credits: totalCredits }),
      });

      if (response.ok) {
        const { url } = await response.json();
        // Stripe 결제 페이지로 리다이렉트
        window.location.href = url;
      } else {
        const error = await response.json();
        alert(error.message || '결제 세션 생성에 실패했습니다.');
      }
    } catch (error) {
      console.error('Payment error:', error);
      alert('결제 처리 중 오류가 발생했습니다.');
    }
  }

  const handleCustomPurchase = async () => {
    if (customCredits < 100) {
      alert('최소 100크레딧부터 구매 가능합니다.')
      return
    }

    try {
      // 결제 세션 생성
      const token = localStorage.getItem('token');
      const response = await fetch('/api/payments/create-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ credits: customCredits }),
      });

      if (response.ok) {
        const { url } = await response.json();
        // Stripe 결제 페이지로 리다이렉트
        window.location.href = url;
      } else {
        const error = await response.json();
        alert(error.message || '결제 세션 생성에 실패했습니다.');
      }
    } catch (error) {
      console.error('Payment error:', error);
      alert('결제 처리 중 오류가 발생했습니다.');
    }
  }

  if (loading) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-1/3 mb-4"></div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-48 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!pricingData) {
    return (
      <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
        <p className="text-red-500">가격 정보를 불러오는데 실패했습니다.</p>
      </div>
    )
  }

  return (
    <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-800 mb-2">🛒 크레딧 구매</h2>
        <p className="text-gray-600 text-sm">
          더 많은 페이지를 분석하려면 크레딧을 구매하세요. 크레딧은 만료되지 않습니다.
        </p>
      </div>

      {/* 패키지 옵션 */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {pricingData.packages.map((pkg, index) => (
          <div
            key={index}
            className={`relative rounded-xl p-6 border-2 transition-all duration-300 hover:shadow-lg ${
              pkg.popular
                ? 'border-blue-500 bg-blue-50 shadow-lg'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            {pkg.popular && (
              <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                <span className="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                  인기
                </span>
              </div>
            )}

            <div className="text-center">
              <h3 className="font-bold text-lg text-gray-800 mb-2">{pkg.name}</h3>
              <div className="text-3xl font-bold text-gray-900 mb-1">
                ${pkg.price}
              </div>
              <div className="text-sm text-gray-600 mb-4">
                {pkg.credits.toLocaleString()} 크레딧
                {pkg.bonus && (
                  <span className="text-green-600 font-medium">
                    {' '}+ {pkg.bonus} 보너스
                  </span>
                )}
              </div>
              
              <div className="space-y-2 mb-6">
                <div className="text-sm text-gray-600">
                  📄 약 {pkg.pages}페이지 분석
                </div>
                <div className="text-xs text-gray-500">
                  페이지당 ${(pkg.price / pkg.pages).toFixed(3)}
                </div>
              </div>

              <button
                onClick={() => handlePackagePurchase(pkg)}
                className={`w-full py-3 px-4 rounded-lg font-medium transition-colors ${
                  pkg.popular
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-900 hover:bg-gray-800 text-white'
                }`}
              >
                구매하기
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 커스텀 크레딧 구매 */}
      <div className="border-t pt-6">
        <h3 className="font-semibold text-gray-700 mb-4">💡 커스텀 구매</h3>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center space-x-4 mb-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                구매할 크레딧 수
              </label>
              <input
                type="number"
                value={customCredits}
                onChange={(e) => setCustomCredits(Number(e.target.value))}
                min="100"
                step="100"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="text-center">
              <div className="text-sm text-gray-600 mb-1">가격</div>
              <div className="text-lg font-bold text-gray-900">
                ${(customCredits / 100).toFixed(2)}
              </div>
            </div>
          </div>
          
          <div className="flex items-center justify-between text-sm text-gray-600 mb-4">
            <span>약 {Math.floor(customCredits / 10)}페이지 분석 가능</span>
            <span>페이지당 $0.10</span>
          </div>

          <button
            onClick={handleCustomPurchase}
            disabled={customCredits < 100}
            className="w-full bg-green-500 hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium py-3 px-4 rounded-lg transition-colors"
          >
            {customCredits < 100 ? '최소 100크레딧 필요' : '커스텀 구매'}
          </button>
        </div>
      </div>

      {/* 결제 정보 */}
      <div className="mt-6 bg-blue-50 rounded-lg p-4">
        <h4 className="font-medium text-blue-800 mb-2">🔒 안전한 결제</h4>
        <div className="text-sm text-blue-700 space-y-1">
          <div>• Stripe을 통한 안전한 결제 처리</div>
          <div>• 크레딧은 즉시 계정에 충전됩니다</div>
          <div>• 크레딧은 만료되지 않습니다</div>
          <div>• 환불 정책은 이용약관을 확인하세요</div>
        </div>
      </div>
    </div>
  )
} 