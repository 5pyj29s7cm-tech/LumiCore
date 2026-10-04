import type { RequestHandler } from 'express';
export function isAllowedClientOrigin(origin?: string): boolean {
    if (!origin)
        return true;
    const configured = String(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (configured.includes(origin))
        return true;
    try {
        const url = new URL(origin);
        if (!['http:', 'https:', 'tauri:'].includes(url.protocol) || url.username || url.password)
            return false;
        return ['127.0.0.1', 'localhost', '[::1]', 'tauri.localhost'].includes(url.hostname)
            && (!url.pathname || url.pathname === '/') && !url.search && !url.hash;
    }
    catch {
        return false;
    }
}
/** CORS response headers do not prevent a simple cross-origin write. */
export const requireTrustedMutationOrigin: RequestHandler = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method))
        return next();
    const origin = req.get('origin');
    if (!isAllowedClientOrigin(origin) || (!origin && req.get('sec-fetch-site') === 'cross-site')) {
        res.status(403).json({ error: 'Untrusted request origin.', code: 'UNTRUSTED_ORIGIN' });
        return;
    }
    next();
};
export function getAuthCookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'none' | 'lax';
    maxAge: number;
} {
    const development = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    return { httpOnly: true, secure: !development, sameSite: development ? 'lax' : 'none', maxAge: 24 * 60 * 60 * 1000 };
}
