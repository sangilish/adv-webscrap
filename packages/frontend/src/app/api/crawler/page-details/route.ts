import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    console.log('Page details API proxy called with:', body);

    // 백엔드 API로 요청 프록시
    const response = await fetch('http://localhost:3003/crawler/page-details', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Backend response: ${response.status}`);
    }

    const data = await response.json();
    console.log('Backend page details response received successfully');

    return NextResponse.json(data);
  } catch (error) {
    console.error('Backend page details connection failed:', error);
    
    return NextResponse.json(
      {
        error: '페이지 상세 정보를 가져올 수 없습니다.',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
} 