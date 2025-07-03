export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    
    if (!authHeader) {
      return Response.json({ error: 'Authorization header required' }, { status: 401 })
    }

    const body = await request.json()

    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3003';
    const response = await fetch(`${backendUrl}/crawler/start`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    const data = await response.json()
    
    return Response.json(data, { status: response.status })
  } catch (error) {
    console.error('Crawler start proxy error:', error)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
} 