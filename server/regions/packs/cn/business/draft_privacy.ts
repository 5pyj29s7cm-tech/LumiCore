/** A bounded identifier scrubber, not a claim of semantic anonymity. */
export function redactDraftIdentifiers(text: string): string {
    return String(text || '')
        .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, '[phone redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email redacted]')
        .replace(/(?<!\d)\d{15,19}[Xx]?(?!\d)/gu, '[identifier redacted]')
        .replace(/(?:姓名|联系人|收件人|详细地址|收货地址|地址|订单号|name|recipient|address|order\s*(?:id|number))\s*[:：=]\s*[^；;。\r\n]+/giu, '[personal field redacted]');
}
