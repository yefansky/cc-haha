import { errorResponse } from '../middleware/errorHandler.js'
import { ksccOAuthService } from '../services/ksccOAuthService.js'

export async function handleKsccOAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]
    if (action === 'start' && req.method === 'POST') {
      return Response.json(await ksccOAuthService.start())
    }
    if ((action === undefined || action === 'status') && req.method === 'GET') {
      return Response.json(await ksccOAuthService.status())
    }
    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}
