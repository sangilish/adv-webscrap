import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('session_id');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // 백엔드에 세션 상태 조회 요청
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3003';
    const response = await fetch(`${backendUrl}/payments/session-status?session_id=${sessionId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Backend error:', errorData);
      throw new Error('세션 상태 조회 실패');
    }

    const data = await response.json();
    return NextResponse.json(data);

  } catch (error) {
    console.error('Session status API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 