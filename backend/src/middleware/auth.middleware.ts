import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { verifyToken, JwtPayload } from '../utils/jwt';

// Extend Express Request to carry the authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * authenticate — verifies the JWT in the Authorization header.
 * Attaches the decoded payload to `req.user`.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * authorize — restricts access to specific roles.
 * Must be used AFTER `authenticate`.
 */
export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Access denied. Required roles: ${roles.join(', ')}`,
      });
      return;
    }
    next();
  };
}
