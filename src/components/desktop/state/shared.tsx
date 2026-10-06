

export const IDLE_AWAY_SECONDS = 5 * 60;

export const RETURN_IDLE_SECONDS = 30;

// Full-screen utility surfaces can be opened from the Command Center.  Keep
// the origin explicit so closing an overlay returns to the surface the user
// came from instead of silently falling back to the personal desktop.
export type SurfaceReturnTarget = 'home' | 'command-center';
