import { NextRequest, NextResponse } from 'next/server';

// Edge runtime에서는 로컬 백엔드(HTTP) 호출이 차단되므로 Node.js 런타임을 명시합니다.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    console.log('Frontend API proxy called with:', body);
    
    // 백엔드 API로 요청 프록시
    try {
      const response = await fetch('http://localhost:3003/crawler/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json();
        console.log('Backend response received successfully');
        return NextResponse.json(data);
      } else {
        console.error('Backend response error:', response.status);
        throw new Error(`Backend responded with status: ${response.status}`);
      }
    } catch (backendError) {
      console.error('Backend connection failed:', backendError);
      
      // 백엔드 연결 실패 시 목업 데이터 반환
      const tempId = `preview_${Date.now()}`;
      const pageId = `page_${Date.now()}_test`;
      
      const mockData = {
        results: [
          {
            id: pageId,
            url: body.url,
            title: 'Sample Page Title',
            pageType: 'homepage',
            links: ['https://www.iana.org/domains/example'],
            images: ['https://via.placeholder.com/300x200'],
            headings: [
              { level: 'h1', text: 'Main Heading' },
              { level: 'h2', text: 'Secondary Heading' }
            ],
            forms: 0,
            textContent: 'This is sample content from the crawled page. It contains useful information about the website structure and navigation.',
            screenshotPath: `/temp/${tempId}/screenshots/${pageId}.png`,
            htmlPath: `/temp/${tempId}/html/${pageId}.html`,
            timestamp: new Date().toISOString(),
            metadata: {
              wordCount: 25,
              imageCount: 1,
              linkCount: 1
            }
          },
          {
            id: `page_${Date.now()}_about`,
            url: `${body.url}/about`,
            title: 'About Us',
            pageType: 'about',
            links: [body.url],
            images: [],
            headings: [
              { level: 'h1', text: 'About Our Company' }
            ],
            forms: 0,
            textContent: 'Learn more about our company and mission. We are dedicated to providing excellent service.',
            screenshotPath: `/temp/${tempId}/screenshots/page_about.png`,
            htmlPath: `/temp/${tempId}/html/page_about.html`,
            timestamp: new Date().toISOString(),
            metadata: {
              wordCount: 15,
              imageCount: 0,
              linkCount: 1
            }
          },
          {
            id: `page_${Date.now()}_contact`,
            url: `${body.url}/contact`,
            title: 'Contact Us',
            pageType: 'contact',
            links: [body.url],
            images: [],
            headings: [
              { level: 'h1', text: 'Get in Touch' }
            ],
            forms: 1,
            textContent: 'Contact us for more information. We would love to hear from you.',
            screenshotPath: `/temp/${tempId}/screenshots/page_contact.png`,
            htmlPath: `/temp/${tempId}/html/page_contact.html`,
            timestamp: new Date().toISOString(),
            metadata: {
              wordCount: 12,
              imageCount: 0,
              linkCount: 1
            }
          }
        ],
        networkData: {
          nodes: [
            {
              id: pageId,
              label: 'Sample Page Title',
              color: '#FF6B6B',
              type: 'homepage',
              url: body.url,
              title: 'Sample Page Title',
              screenshot: `/temp/${tempId}/screenshots/${pageId}.png`
            },
            {
              id: `page_${Date.now()}_about`,
              label: 'About Us',
              color: '#4ECDC4',
              type: 'about',
              url: `${body.url}/about`,
              title: 'About Us',
              screenshot: `/temp/${tempId}/screenshots/page_about.png`
            },
            {
              id: `page_${Date.now()}_contact`,
              label: 'Contact Us',
              color: '#45B7D1',
              type: 'contact',
              url: `${body.url}/contact`,
              title: 'Contact Us',
              screenshot: `/temp/${tempId}/screenshots/page_contact.png`
            }
          ],
          edges: [
            {
              from: pageId,
              to: `page_${Date.now()}_about`
            },
            {
              from: pageId,
              to: `page_${Date.now()}_contact`
            }
          ]
        },
        totalPages: 3,
        isPreview: true,
        previewLimit: 5,
        fallback: true // 목업 데이터임을 표시
      };
      
      console.log('Returning fallback mock data for:', body.url);
      return NextResponse.json(mockData);
    }
    
  } catch (error) {
    console.error('API proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data from backend' },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
} 