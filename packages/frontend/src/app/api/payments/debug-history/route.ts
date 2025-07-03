import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    // 토큰 확인
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);

    // 백엔드에 디버그 결제 내역 요청
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3003';
    const response = await fetch(`${backendUrl}/payments/debug-history`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Backend error:', errorData);
      throw new Error('결제 내역 조회 실패');
    }

    const data = await response.json();
    
    return NextResponse.json(data);

  } catch (error) {
    console.error('Debug payment history error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 