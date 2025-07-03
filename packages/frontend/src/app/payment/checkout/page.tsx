'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';

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
    // 기존 checkout DOM 요소들 모두 제거
    const existingElements = document.querySelectorAll('[data-testid="hosted-payment-page"], .StripeElement, #checkout');
    existingElements.forEach(el => {
      try {
        el.remove();
      } catch (e) {
        console.log('Element cleanup failed:', e);
      }
    });

    // 전역 인스턴스 정리
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

    // 초기화 Promise 정리
    globalInitializationPromise = null;

    // sessionStorage 정리
    sessionStorage.removeItem('stripe_checkout_session');
    
    console.log('Force cleanup completed');
  } catch (error) {
    console.error('Force cleanup error:', error);
  }
};

export default function CheckoutPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const hasInitializedRef = useRef(false);
  const searchParams = useSearchParams();
  const router = useRouter();
  
  const credits = searchParams.get('credits');

  // 컴포넌트 마운트/언마운트 관리
  useEffect(() => {
    isMountedRef.current = true;
    hasInitializedRef.current = false;

    return () => {
      isMountedRef.current = false;
      // 컴포넌트 언마운트 시에는 전역 정리하지 않음 (페이지 이동 시 문제 방지)
    };
  }, []);

  // 페이지 언로드 시 전역 정리
  useEffect(() => {
    const handleBeforeUnload = () => {
      forceCleanup();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // 페이지가 숨겨질 때 정리
        setTimeout(forceCleanup, 1000);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // fetchClientSecret 함수
  const fetchClientSecret = useCallback(async () => {
    // sessionStorage에서 기존 세션 확인
    const savedSession = sessionStorage.getItem('stripe_checkout_session');
    if (savedSession) {
      try {
        const { clientSecret, credits: savedCredits, timestamp } = JSON.parse(savedSession);
        // 5분 이내이고 같은 크레딧이면 재사용
        if (Date.now() - timestamp < 300000 && savedCredits === credits) {
          console.log('Reusing saved client secret');
          return clientSecret;
        }
      } catch (e) {
        console.log('Failed to parse saved session');
      }
    }

    const token = localStorage.getItem('token');
    if (!token) {
      throw new Error('로그인이 필요합니다.');
    }

    console.log('Creating new payment session for credits:', credits);
    const response = await fetch('/api/payments/create-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ credits: parseInt(credits!) }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || '결제 세션 생성에 실패했습니다.');
    }

    const { clientSecret } = await response.json();
    
    // sessionStorage에 저장
    sessionStorage.setItem('stripe_checkout_session', JSON.stringify({
      clientSecret,
      credits,
      timestamp: Date.now()
    }));

    return clientSecret;
  }, [credits]);

  useEffect(() => {
    if (!credits) {
      setError('크레딧 수량이 지정되지 않았습니다.');
      return;
    }

    // 이미 초기화되었거나 초기화 중인 경우 중복 방지
    if (hasInitializedRef.current || globalInitializationPromise) {
      console.log('Initialization already in progress or completed');
      return;
    }

    const initializeCheckout = async () => {
      try {
        hasInitializedRef.current = true;
        console.log('=== Starting Stripe Checkout Initialization ===');

        // 컴포넌트가 언마운트된 경우 중단
        if (!isMountedRef.current) {
          console.log('Component unmounted, aborting initialization');
          return;
        }

        // 강제 정리
        forceCleanup();

        // 잠시 대기 (DOM 정리 완료를 위해)
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
        
        // DOM 요소 재생성
        if (checkoutRef.current) {
          checkoutRef.current.innerHTML = '';
          // 고유 ID 설정
          checkoutRef.current.id = `checkout-${Date.now()}`;
        }

        let checkout: any = globalCheckoutInstance;

        if (!checkout) {
          // Embedded Checkout 초기화 (최초 한 번)
          checkout = await stripe.initEmbeddedCheckout({
            fetchClientSecret,
          });
          globalCheckoutInstance = checkout; // 저장
          console.log('Checkout instance created successfully');
        } else {
          console.log('Reusing existing checkout instance');
        }

        if (!isMountedRef.current) {
          try {
            checkout.unmount();
          } catch (e) {
            console.log('Cleanup of unused checkout failed:', e);
          }
          return;
        }

        // DOM에 마운트
        if (checkoutRef.current && isMountedRef.current) {
          console.log('Mounting checkout to DOM...');
          await checkout.mount(checkoutRef.current);
          console.log('✅ Checkout mounted successfully');
        }

        if (isMountedRef.current) {
          setIsLoading(false);
        }

      } catch (error) {
        console.error('❌ Checkout initialization error:', error);
        if (isMountedRef.current) {
          setError(error instanceof Error ? error.message : '결제 페이지 로드에 실패했습니다.');
          setIsLoading(false);
        }
      } finally {
        globalInitializationPromise = null;
        hasInitializedRef.current = false;
      }
    };

    // 전역 초기화 Promise로 중복 방지
    if (!globalInitializationPromise) {
      globalInitializationPromise = initializeCheckout();
    }

  }, [credits, fetchClientSecret]);

  const handleRetry = () => {
    setError(null);
    setIsLoading(true);
    hasInitializedRef.current = false;
    forceCleanup();
    // 강제 리로드
    window.location.reload();
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <div className="text-center">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="mt-4 text-lg font-medium text-gray-900">결제 페이지 오류</h3>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
            <div className="mt-4 space-y-3">
              <button
                onClick={handleRetry}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                다시 시도
              </button>
              <button
                onClick={() => router.back()}
                className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                돌아가기
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h1 className="text-xl font-semibold text-gray-900">크레딧 구매</h1>
            {credits && (
              <p className="mt-2 text-sm text-gray-600">
                {credits}크레딧 구매 (약 {Math.ceil(parseInt(credits) / 10)}페이지 분석 가능)
              </p>
            )}
          </div>
          
          <div className="p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
                <span className="ml-3 text-gray-600">결제 페이지를 로드하는 중...</span>
              </div>
            ) : (
              <div>
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <p className="text-sm text-blue-600">
                    안전한 결제를 위해 Stripe를 사용합니다. 카드 정보는 암호화되어 처리됩니다.
                  </p>
                </div>
                <div ref={checkoutRef} className="min-h-[400px]">
                  {/* Stripe Checkout이 여기에 마운트됩니다 */}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
} 