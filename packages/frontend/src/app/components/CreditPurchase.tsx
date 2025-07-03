'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { loadStripe } from '@stripe/stripe-js'

// Stripe publishable key
const stripePromise = loadStripe('pk_test_51RgR7aD6TknMMBFoNVwk0m200DsM72tXY5tgGv0U5sfnnHNfwCN2PJzkvtN6mPLqHP4HdMIddgxilRGkQ5qXAsbP00KOIa5gPN', {
  betas: ['embedded_checkout_beta_1'],
});

// 전역 Checkout 인스턴스 관리
let globalCheckoutInstance: any = null;
let globalInitializationPromise: Promise<any> | null = null;

// 강제 정리 함수
const forceCleanup = () => {
  try {
    const existingElements = document.querySelectorAll('[data-testid="hosted-payment-page"], .StripeElement, #checkout');
    existingElements.forEach(el => {
      try {
        el.remove();
      } catch (e) {
        console.log('Element cleanup failed:', e);
      }
    });

    if (globalCheckoutInstance) {
      try {
        if (typeof globalCheckoutInstance.destroy === 'function') {
          globalCheckoutInstance.destroy();
        } else if (typeof globalCheckoutInstance.unmount === 'function') {
          globalCheckoutInstance.unmount();
        }
        console.log('Global checkout instance unmounted/destroyed');
      } catch (e) {
        console.log('Global instance unmount failed:', e);
      }
      globalCheckoutInstance = null;
    }

    globalInitializationPromise = null;
    sessionStorage.removeItem('stripe_checkout_session');
    console.log('Force cleanup completed');
  } catch (error) {
    console.error('Force cleanup error:', error);
  }
};

export default function CreditPurchase() {
  const router = useRouter()
  const [selectedPages, setSelectedPages] = useState<number>(10)
  const [paymentType, setPaymentType] = useState<'one-time' | 'subscription'>('one-time')
  const [showCheckout, setShowCheckout] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const checkoutRef = useRef<HTMLDivElement>(null)
  const isMountedRef = useRef(true)
  const hasInitializedRef = useRef(false)

  // 가격 계산
  const PAGE_PRICE = 0.25 // 페이지당 $0.25
  const SUBSCRIPTION_PRICE = 70 // 월 500페이지 $70 (원래 $100에서 할인)
  const SUBSCRIPTION_PAGES = 500

  const calculatePrice = () => {
    if (paymentType === 'subscription') {
      return SUBSCRIPTION_PRICE
    }
    return selectedPages * PAGE_PRICE
  }

  const calculateCredits = () => {
    // 1페이지당 10크레딧으로 계산
    if (paymentType === 'subscription') {
      return SUBSCRIPTION_PAGES * 10
    }
    return selectedPages * 10
  }

  // 컴포넌트 마운트/언마운트 관리
  useEffect(() => {
    isMountedRef.current = true
    hasInitializedRef.current = false

    return () => {
      isMountedRef.current = false
      if (showCheckout) {
        forceCleanup()
      }
    }
  }, [showCheckout])

  // 결제 세션 생성
  const fetchClientSecret = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      throw new Error('로그인이 필요합니다.');
    }

    const credits = calculateCredits()
    const amount = calculatePrice()

    console.log('Creating payment session:', { credits, amount, paymentType });
    
    const response = await fetch('/api/payments/create-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ 
        credits, 
        amount,
        paymentType 
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '결제 세션 생성에 실패했습니다.');
    }

    const { clientSecret } = await response.json();
    return clientSecret;
  }, [selectedPages, paymentType]);

  // Stripe Checkout 초기화
  const initializeCheckout = async () => {
    try {
      setCheckoutLoading(true)
      setError(null)
      hasInitializedRef.current = true;
      console.log('=== Starting Stripe Checkout Initialization ===');

      if (!isMountedRef.current) {
        return;
      }

      forceCleanup();
      await new Promise(resolve => setTimeout(resolve, 100));

      if (!isMountedRef.current) {
        return;
      }

      const stripe = await stripePromise;
      if (!stripe) {
        throw new Error('Stripe를 로드할 수 없습니다.');
      }

      if (!isMountedRef.current) {
        return;
      }

      console.log('Initializing Embedded Checkout...');
      
      if (checkoutRef.current) {
        checkoutRef.current.innerHTML = '';
        checkoutRef.current.id = `checkout-${Date.now()}`;
      }

      let checkout: any = globalCheckoutInstance;

      if (!checkout) {
        console.log('Creating new embedded checkout instance...');
        const clientSecret = await fetchClientSecret();
        
        if (!isMountedRef.current) {
          return;
        }

        checkout = await stripe.initEmbeddedCheckout({
          clientSecret,
        });

        globalCheckoutInstance = checkout;
        console.log('New embedded checkout instance created');
      } else {
        console.log('Reusing existing checkout instance');
      }

      if (!isMountedRef.current) {
        return;
      }

      if (checkoutRef.current) {
        console.log('Mounting checkout to DOM element:', checkoutRef.current.id);
        await checkout.mount(checkoutRef.current);
        console.log('Checkout mounted successfully');
      }

      setCheckoutLoading(false)
    } catch (err: any) {
      console.error('Checkout initialization error:', err);
      setError(err.message || 'Checkout 초기화에 실패했습니다.');
      setCheckoutLoading(false)
      hasInitializedRef.current = false;
    }
  };

  // 결제하기 버튼 클릭
  const handlePaymentClick = () => {
    if (!showCheckout) {
      setShowCheckout(true)
      // 다음 틱에서 Checkout 초기화
      setTimeout(() => {
        initializeCheckout()
      }, 100)
    }
  }

  // 새로운 결제 시작
  const handleNewPayment = () => {
    forceCleanup()
    setShowCheckout(false)
    setError(null)
    hasInitializedRef.current = false
  }

  return (
    <div className="bg-white/90 backdrop-blur-lg rounded-2xl shadow-xl p-6 border border-white/20">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-800 mb-2">💳 크레딧 구매</h2>
        <p className="text-gray-600 text-sm">
          분석하고 싶은 페이지 수를 선택하거나 구독 플랜을 이용하세요.
        </p>
      </div>

      {/* 결제 타입 선택 */}
      <div className="mb-6">
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => { setPaymentType('one-time'); handleNewPayment(); }}
            className={`p-4 rounded-lg border-2 transition-all ${
              paymentType === 'one-time'
                ? 'border-blue-500 bg-blue-50 text-blue-800'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <div className="text-lg font-semibold">일회성 구매</div>
            <div className="text-sm">페이지당 $0.25</div>
          </button>
          
          <button
            onClick={() => { setPaymentType('subscription'); handleNewPayment(); }}
            className={`p-4 rounded-lg border-2 transition-all relative ${
              paymentType === 'subscription'
                ? 'border-green-500 bg-green-50 text-green-800'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <div className="absolute -top-2 -right-2 bg-red-500 text-white text-xs px-2 py-1 rounded-full">
              30% 할인
            </div>
            <div className="text-lg font-semibold">월 구독</div>
            <div className="text-sm">500페이지 $70/월</div>
            <div className="text-xs opacity-75 line-through">원래 $100</div>
          </button>
        </div>
      </div>

      {/* 페이지 수 선택 (일회성 구매인 경우) */}
      {paymentType === 'one-time' && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-3">
            분석할 페이지 수
          </label>
          
          {/* 빠른 선택 버튼들 */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {[10, 25, 50, 100].map((pages) => (
              <button
                key={pages}
                onClick={() => { setSelectedPages(pages); handleNewPayment(); }}
                className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                  selectedPages === pages
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {pages}페이지
              </button>
            ))}
          </div>

          {/* 커스텀 입력 */}
          <div className="flex items-center space-x-4">
            <input
              type="number"
              value={selectedPages}
              onChange={(e) => { setSelectedPages(Number(e.target.value)); handleNewPayment(); }}
              min="1"
              step="1"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="페이지 수 입력"
            />
            <div className="text-right">
              <div className="text-sm text-gray-600">총 가격</div>
              <div className="text-2xl font-bold text-gray-900">
                ${calculatePrice().toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 구독 정보 (구독인 경우) */}
      {paymentType === 'subscription' && (
        <div className="mb-6 bg-green-50 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-green-800">월간 구독 플랜</h3>
              <p className="text-sm text-green-700">월 500페이지 분석 가능</p>
              <p className="text-xs text-green-600">페이지당 $0.14 (43% 할인!)</p>
            </div>
            <div className="text-right">
              <div className="text-sm text-green-600">월 요금</div>
              <div className="text-2xl font-bold text-green-800">$70</div>
              <div className="text-xs text-green-600 line-through">원래 $100</div>
            </div>
          </div>
        </div>
      )}

      {/* 결제 정보 요약 */}
      <div className="mb-6 bg-gray-50 rounded-lg p-4">
        <h3 className="font-medium text-gray-800 mb-2">결제 정보</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span>
              {paymentType === 'subscription' ? '월 구독 (500페이지)' : `${selectedPages}페이지 분석`}
            </span>
            <span>${calculatePrice().toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>크레딧</span>
            <span>{calculateCredits().toLocaleString()} 크레딧</span>
          </div>
          <div className="border-t pt-2 flex justify-between font-semibold">
            <span>총 결제 금액</span>
            <span>${calculatePrice().toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* 결제하기 버튼 */}
      {!showCheckout && (
        <button
          onClick={handlePaymentClick}
          className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-semibold py-4 px-6 rounded-lg transition-all transform hover:scale-105 shadow-lg"
        >
          💳 결제하기 (${calculatePrice().toFixed(2)})
        </button>
      )}

      {/* Stripe Checkout */}
      {showCheckout && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">결제 정보 입력</h3>
            <button
              onClick={handleNewPayment}
              className="text-gray-500 hover:text-gray-700 text-sm"
            >
              다시 선택하기
            </button>
          </div>
          
          {checkoutLoading && (
            <div className="bg-gray-50 rounded-lg p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
              <p className="text-gray-600">결제 폼을 로딩 중...</p>
            </div>
          )}
          
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
              <p className="text-red-700">{error}</p>
              <button
                onClick={() => { setError(null); initializeCheckout(); }}
                className="mt-2 text-red-600 hover:text-red-800 text-sm underline"
              >
                다시 시도
              </button>
            </div>
          )}
          
          <div 
            ref={checkoutRef}
            className="min-h-[400px] bg-white rounded-lg border border-gray-200"
          />
        </div>
      )}

      {/* 결제 안내 */}
      <div className="mt-6 bg-blue-50 rounded-lg p-4">
        <h4 className="font-medium text-blue-800 mb-2">🔒 안전한 결제</h4>
        <div className="text-sm text-blue-700 space-y-1">
          <div>• Stripe을 통한 안전한 결제 처리</div>
          <div>• 크레딧은 즉시 계정에 충전됩니다</div>
          <div>• 크레딧은 만료되지 않습니다</div>
          <div>• 구독은 언제든지 취소 가능합니다</div>
        </div>
      </div>
    </div>
  )
} 