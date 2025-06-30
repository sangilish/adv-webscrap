export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    const response = await fetch('http://localhost:3003/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    
    return Response.json(data, { status: response.status });
  } catch (error) {
    console.error('Login proxy error:', error);
    return Response.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
} 