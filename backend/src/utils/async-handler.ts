import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async Express route handler so a rejected promise is forwarded to
 * next(err) — and thus to the global error handler — instead of becoming an
 * unhandled rejection that crashes the process.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
