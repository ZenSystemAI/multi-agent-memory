const API_KEY = process.env.BRAIN_API_KEY;

export function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}
