export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    
    if (!authHeader) {
      return Response.json({ error: 'Authorization header required' }, { status: 401 })
    }

    const response = await fetch('http://localhost:3003/crawler/analyses', {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    })

    const data = await response.json()
    
    return Response.json(data, { status: response.status })
  } catch (error) {
    console.error('Crawler analyses proxy error:', error)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
} 