import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tempId: string; filename: string }> }
) {
  try {
    const { tempId, filename } = await params;
    
    console.log('Screenshot proxy called:', tempId, filename);
    
    // 백엔드 스크린샷 API로 요청 프록시
    const response = await fetch(`http://localhost:3003/crawler/temp-screenshot/${tempId}/${filename}`);
    
    if (!response.ok) {
      console.error('Backend screenshot error:', response.status);
      return NextResponse.json(
        { error: 'Screenshot not found' },
        { status: 404 }
      );
    }
    
    const buffer = await response.arrayBuffer();
    
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Screenshot proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch screenshot' },
      { status: 500 }
    );
  }
} 