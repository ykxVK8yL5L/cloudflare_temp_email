import type { WorkflowMail } from './types';

export const getWorkflowValue = (mail: WorkflowMail, field: unknown): unknown => {
    if (typeof field !== 'string') return undefined;
    if (field === 'hasAttachments') return mail.attachmentCount > 0;
    if (field === 'attachmentCount') return mail.attachmentCount;
    if (field === 'extract.type') return mail.extract?.type;
    if (field === 'extract.result') return mail.extract?.result;
    if (field === 'extract.result_text') return mail.extract?.result_text;
    if (field === 'extract.source') return mail.extract?.source;
    return mail[field as keyof WorkflowMail];
};

export const matchesWorkflowCondition = (mail: WorkflowMail, config: Record<string, unknown>): boolean => {
    const actual = getWorkflowValue(mail, config.field);
    const expected = config.value;
    const left = String(actual ?? '');
    const right = String(expected ?? '');
    switch (config.operator) {
        case 'equals': return left === right;
        case 'not_equals': return left !== right;
        case 'contains': return left.includes(right);
        case 'not_contains': return !left.includes(right);
        case 'starts_with': return left.startsWith(right);
        case 'ends_with': return left.endsWith(right);
        case 'exists': return actual !== undefined && actual !== null && actual !== '';
        case 'matches': {
            if (right.length > 200) return false;
            try { return new RegExp(right, 'i').test(left); } catch { return false; }
        }
        default: return false;
    }
};

export const selectWorkflowSwitchBranch = (mail: WorkflowMail, config: Record<string, unknown>): string => {
    const cases = Array.isArray(config.cases) ? config.cases : [];
    for (const item of cases) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Record<string, unknown>;
        if (matchesWorkflowCondition(mail, { field: config.field, operator: candidate.operator, value: candidate.value })) {
            return String(candidate.id);
        }
    }
    return 'default';
};

export const renderWorkflowTemplate = (template: unknown, mail: WorkflowMail): string => String(template ?? '').replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (_, field: string) => String(getWorkflowValue(mail, field) ?? '')
);

export const getWorkflowExtractSource = (mail: WorkflowMail, source: unknown): string => {
    switch (source) {
        case 'subject': return mail.subject;
        case 'from': return mail.from;
        case 'to': return mail.to;
        case 'text': return mail.text;
        case 'html': return mail.html;
        case 'raw': return mail.raw;
        default: return `${mail.subject}\n${mail.text || mail.html}`;
    }
};

export const extractWorkflowPattern = (
    content: string,
    pattern: unknown,
    captureGroup: unknown,
    caseSensitive: unknown,
): string => {
    const match = new RegExp(String(pattern), caseSensitive === true ? '' : 'i').exec(content.slice(0, 10000));
    const group = Number(captureGroup ?? 1);
    return match?.[group] ?? match?.[0] ?? '';
};

export const isPrivateWebhookHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host === '::' || host.endsWith('.local')) return true;
    if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
        || host.startsWith('::ffff:127.') || host.startsWith('::ffff:10.') || host.startsWith('::ffff:192.168.'))) return true;
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
};
