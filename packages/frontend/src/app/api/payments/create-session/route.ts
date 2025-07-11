import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { credits, amount, paymentType } = await request.json();
    
    if (!credits || credits < 10) {
      return NextResponse.json(
        { error: '최소 10크레딧부터 구매 가능합니다.' },
        { status: 400 }
      );
    }

    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: '유효한 금액이 필요합니다.' },
        { status: 400 }
      );
    }

    // 토큰 확인
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);

    // 백엔드에 결제 세션 생성 요청
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3003';
    const response = await fetch(`${backendUrl}/payments/create-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ 
        credits, 
        amount,
        paymentType: paymentType || 'one-time'
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Backend error:', errorData);
      throw new Error('결제 세션 생성 실패');
    }

    const data = await response.json();
    
    // Embedded Checkout을 위한 clientSecret 반환
    return NextResponse.json({ 
      clientSecret: data.clientSecret,
      sessionId: data.sessionId,
      amount: data.amount,
      credits: data.credits,
      paymentType: data.paymentType
    });

  } catch (error) {
    console.error('Create payment session error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 