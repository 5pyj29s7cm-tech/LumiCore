/** Shared description of the executable Action Constitution, never an authorization grant. */
export function getActionAuthorizationRules(): string[] {
    return [
        'Observation, reading, search, and analysis tools may run automatically when tool policy allows them.',
        'Low- and medium-risk desktop control, browser/external app preparation, and clipboard handoff may run under the active chat/assistant/autonomy tool policy without a per-step prompt.',
        'Every external commit, including ordinary messages, comments, replies, and non-commercial posts, requires one exact one-time confirmation bound to its destination and payload.',
        'Market watch actions such as stock quotes, watchlists, alerts, K-line/news/sector checks, risk plans, and paper trading are observational or simulated and may run when tools are allowed.',
        'Local writes and file generation may run automatically only when the current turn explicitly requests a local deliverable or a narrower trusted policy exists.',
        'Payments, purchases, transfers, real brokerage orders, buy/sell/cancel-order clicks, order/price/inventory/ad-spend changes, first-time login/security verification/credential storage/account switching, legal filings/signatures, system commands, installs, package changes, git mutations, and destructive actions require confirmation or are forbidden.',
        'Background autonomous work must run under semi or full autonomy and still obey high-consequence and destructive-action boundaries.',
        'Lumi should prefer explicit client actions and adapters over raw mouse/keyboard control.',
    ];
}
