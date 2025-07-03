'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface SessionStatus {
  status: string;
  customer_email: string;
  payment_status: string;
}

export default function PaymentReturnPage() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  
  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    const checkSessionStatus = async () => {
      if (!sessionId) {
        setError('세션 ID가 없습니다.');
        setIsLoading(false);
        return;
      }

      try {
        // Reference 코드 방식: session-status API 호출
        const response = await fetch(`/api/payments/session-status?session_id=${sessionId}`);
        
        if (!response.ok) {
          throw new Error('세션 상태 확인에 실패했습니다.');
        }

        const session = await response.json();
        setSessionStatus(session);

        // Reference 코드 방식: 상태에 따른 처리
        if (session.status === 'open') {
          // 아직 결제가 완료되지 않은 경우 checkout 페이지로 리다이렉트
          router.replace('/payment/checkout');
          return;
        }

        // 결제가 완료된 경우 수동으로 결제 처리 (웹훅 대신)
        if (session.status === 'complete' && session.payment_status === 'paid') {
          try {
            const token = localStorage.getItem('token');
            if (token) {
              const processResponse = await fetch('/api/payments/process-payment', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ sessionId }),
              });

              if (processResponse.ok) {
                const result = await processResponse.json();
                console.log('Payment processed successfully:', result);
              } else {
                console.error('Failed to process payment:', await processResponse.text());
              }
            }
          } catch (processError) {
            console.error('Payment processing error:', processError);
            // 에러가 발생해도 페이지는 정상적으로 표시
          }
        }

        setIsLoading(false);
      } catch (error) {
        console.error('Session status check error:', error);
        setError(error instanceof Error ? error.message : '세션 상태 확인에 실패했습니다.');
        setIsLoading(false);
      }
    };

    checkSessionStatus();
  }, [sessionId, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">결제 상태를 확인하는 중...</p>
        </div>
      </div>
    );
  }

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
            <h3 className="mt-4 text-lg font-medium text-gray-900">오류 발생</h3>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
            <Link
              href="/dashboard/credits"
              className="mt-4 inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              크레딧 페이지로 돌아가기
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto py-8 px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          {sessionStatus?.status === 'complete' ? (
            <div id="success" className="p-6">
              <div className="text-center">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100">
                  <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-medium text-gray-900">결제 완료!</h3>
                <p className="mt-2 text-sm text-gray-500">
                  크레딧 구매가 성공적으로 완료되었습니다.
                </p>
                {sessionStatus.customer_email && (
                  <p className="mt-2 text-sm text-gray-600">
                    구매자: <span id="customer-email" className="font-medium">{sessionStatus.customer_email}</span>
                  </p>
                )}
                <div className="mt-6 space-y-3">
                  <Link
                    href="/dashboard/credits"
                    className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    크레딧 확인하기
                  </Link>
                  <Link
                    href="/dashboard"
                    className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    대시보드로 돌아가기
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6">
              <div className="text-center">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100">
                  <svg className="h-6 w-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 19.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-medium text-gray-900">결제 처리 중</h3>
                <p className="mt-2 text-sm text-gray-500">
                  결제가 아직 처리되지 않았습니다. 잠시만 기다려주세요.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-4 inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  상태 다시 확인
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 