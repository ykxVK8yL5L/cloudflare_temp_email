import type { WorkflowDefinition, WorkflowNodeType, WorkflowValidationResult } from './types';

const NODE_TYPES = new Set<WorkflowNodeType>([
    'trigger.received', 'condition.filter', 'condition.switch', 'process.extract', 'process.delay',
    'action.webhook', 'action.forward', 'action.auto_reply',
    'action.reject', 'action.stop',
]);
const SYNC_ONLY = new Set<WorkflowNodeType>(['action.forward', 'action.auto_reply', 'action.reject']);
const DURABLE = new Set<WorkflowNodeType>(['process.extract', 'process.delay', 'action.webhook']);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FIELDS = new Set(['from', 'to', 'subject', 'text', 'html', 'messageId', 'hasAttachments', 'attachmentCount', 'extract.type', 'extract.result', 'extract.result_text', 'extract.source']);
const OPERATORS = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'exists']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const EXTRACT_MODES = new Set(['smart', 'regex']);
const EXTRACT_SOURCES = new Set(['subject_text', 'subject', 'from', 'to', 'text', 'html', 'raw']);

const isIntegerInRange = (value: unknown, min: number, max: number) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max;
};

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition | null {
    if (typeof value === 'string') {
        try { return JSON.parse(value) as WorkflowDefinition; } catch { return null; }
    }
    return value && typeof value === 'object' ? value as WorkflowDefinition : null;
}

export function validateWorkflowDefinition(value: unknown, hasDurableBinding = true): WorkflowValidationResult {
    const definition = parseWorkflowDefinition(value);
    const errors: string[] = [];
    if (!definition || definition.version !== 1 || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
        return { valid: false, errors: ['Invalid workflow definition'] };
    }
    if (JSON.stringify(definition).length > 65536) errors.push('Workflow definition cannot exceed 64 KiB');
    if (definition.nodes.length < 1 || definition.nodes.length > 50) errors.push('A workflow must contain 1 to 50 nodes');
    if (definition.edges.length > 100) errors.push('A workflow cannot contain more than 100 edges');

    const nodeIds = new Set<string>();
    for (const node of definition.nodes) {
        if (!node || !ID_PATTERN.test(node.id || '')) errors.push('Every node must have a valid unique ID');
        if (nodeIds.has(node.id)) errors.push(`Duplicate node ID: ${node.id}`);
        nodeIds.add(node.id);
        if (!NODE_TYPES.has(node.type)) errors.push(`Unsupported node type: ${node.type}`);
        const config = node.config || {};
        if (config.retryLimit !== undefined && !isIntegerInRange(config.retryLimit, 0, 5)) {
            errors.push(`Node ${node.id} retry limit must be an integer between 0 and 5`);
        }
        if (config.retryDelaySeconds !== undefined && !isIntegerInRange(config.retryDelaySeconds, 1, 3600)) {
            errors.push(`Node ${node.id} retry delay must be between 1 and 3600 seconds`);
        }
        if (config.timeoutSeconds !== undefined && !isIntegerInRange(config.timeoutSeconds, 1, 300)) {
            errors.push(`Node ${node.id} timeout must be between 1 and 300 seconds`);
        }
        if (node.type === 'condition.filter' && (!FIELDS.has(String(config.field)) || !OPERATORS.has(String(config.operator)))) {
            errors.push(`Condition node ${node.id} has an invalid field or operator`);
        }
        if (node.type === 'condition.switch') {
            const cases = Array.isArray(config.cases) ? config.cases : [];
            if (!FIELDS.has(String(config.field))) errors.push(`Switch node ${node.id} has an invalid field`);
            if (cases.length < 1 || cases.length > 10) errors.push(`Switch node ${node.id} must contain 1 to 10 cases`);
            const caseIds = new Set<string>();
            for (const item of cases) {
                const candidate = item && typeof item === 'object' ? item as Record<string, unknown> : {};
                const caseId = String(candidate.id || '');
                if (!ID_PATTERN.test(caseId) || caseId === 'default' || caseIds.has(caseId)) errors.push(`Switch node ${node.id} has an invalid or duplicate case ID`);
                caseIds.add(caseId);
                if (!OPERATORS.has(String(candidate.operator))) errors.push(`Switch node ${node.id} has an invalid case operator`);
            }
        }
        if (node.type === 'process.delay' && (!Number.isFinite(Number(config.seconds)) || Number(config.seconds) < 1 || Number(config.seconds) > 2592000)) {
            errors.push(`Delay node ${node.id} must be between 1 and 2592000 seconds`);
        }
        if (node.type === 'process.extract') {
            const mode = String(config.mode || 'smart');
            if (!EXTRACT_MODES.has(mode)) errors.push(`Extract node ${node.id} has an invalid mode`);
            if (!EXTRACT_SOURCES.has(String(config.source || 'subject_text'))) errors.push(`Extract node ${node.id} has an invalid source`);
            if (mode === 'regex') {
                const pattern = String(config.pattern || '');
                if (!pattern || pattern.length > 200) errors.push(`Extract node ${node.id} requires a pattern of at most 200 characters`);
                else try { new RegExp(pattern); } catch { errors.push(`Extract node ${node.id} has an invalid regular expression`); }
                if (!isIntegerInRange(config.captureGroup ?? 1, 0, 20)) errors.push(`Extract node ${node.id} capture group must be between 0 and 20`);
                if (typeof config.resultType !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.resultType)) {
                    errors.push(`Extract node ${node.id} requires a valid result type`);
                }
            }
        }
        if (node.type === 'action.forward' && (typeof config.address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.address))) {
            errors.push(`Forward node ${node.id} requires a valid email address`);
        }
        if (node.type === 'action.webhook') {
            try {
                const url = new URL(String(config.url || ''));
                if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
                const headers = JSON.parse(String(config.headers || '{}'));
                if (!headers || Array.isArray(headers) || typeof headers !== 'object'
                    || Object.values(headers).some(value => typeof value !== 'string')) throw new Error();
                if (!HTTP_METHODS.has(String(config.method || 'POST').toUpperCase())) throw new Error();
            } catch { errors.push(`Webhook node ${node.id} requires an HTTP(S) URL and valid headers JSON`); }
        }
        if (node.type === 'action.auto_reply' && typeof config.body !== 'string') errors.push(`Auto-reply node ${node.id} requires a body`);
    }
    const triggers = definition.nodes.filter(node => node.type === 'trigger.received');
    if (triggers.length !== 1) errors.push('A workflow must contain exactly one received-email trigger');

    const adjacency = new Map<string, string[]>();
    const incoming = new Map<string, number>();
    const edgeIds = new Set<string>();
    for (const edge of definition.edges) {
        if (!ID_PATTERN.test(edge.id || '') || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
            errors.push(`Invalid edge: ${edge?.id || 'unknown'}`);
            continue;
        }
        if (edgeIds.has(edge.id)) errors.push(`Duplicate edge ID: ${edge.id}`);
        edgeIds.add(edge.id);
        if (edge.source === edge.target) errors.push(`Self-referencing edge: ${edge.id}`);
        adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), edge.target]);
        incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    }
    for (const node of definition.nodes) {
        const nodeEdges = definition.edges.filter(edge => edge.source === node.id);
        if (node.type === 'condition.filter') {
            if (nodeEdges.filter(edge => edge.sourceHandle === 'true').length > 1
                || nodeEdges.filter(edge => edge.sourceHandle === 'false').length > 1
                || nodeEdges.some(edge => !['true', 'false'].includes(edge.sourceHandle || ''))) {
                errors.push(`Condition node ${node.id} supports at most one true and one false edge`);
            }
        } else if (node.type === 'condition.switch') {
            const cases = Array.isArray(node.config?.cases) ? node.config.cases as Record<string, unknown>[] : [];
            const handles = new Set(cases.map(item => String(item.id)));
            handles.add('default');
            if (nodeEdges.some(edge => !handles.has(edge.sourceHandle || 'default'))
                || [...handles].some(handle => nodeEdges.filter(edge => (edge.sourceHandle || 'default') === handle).length > 1)) {
                errors.push(`Switch node ${node.id} has invalid or duplicate branches`);
            }
        } else {
            if (nodeEdges.length > 1) errors.push(`Node ${node.id} supports only one outgoing edge`);
            if (nodeEdges.some(edge => !['', 'default'].includes(edge.sourceHandle || ''))) {
                errors.push(`Node ${node.id} only supports the default branch`);
            }
        }
    }
    for (const [nodeId, count] of incoming) {
        const node = definition.nodes.find(item => item.id === nodeId);
        if (count > 1 && node?.type !== 'action.stop') errors.push(`Node ${nodeId} supports only one incoming edge`);
    }
    if (triggers[0] && (incoming.get(triggers[0].id) || 0) > 0) errors.push('The trigger cannot have incoming edges');

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        if ((adjacency.get(id) || []).some(hasCycle)) {
            visiting.delete(id);
            return true;
        }
        visiting.delete(id);
        visited.add(id);
        return false;
    };
    if (triggers[0] && hasCycle(triggers[0].id)) errors.push('Workflow graphs cannot contain cycles');
    const reachable = new Set<string>();
    const markReachable = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        for (const target of adjacency.get(id) || []) markReachable(target);
    };
    if (triggers[0]) markReachable(triggers[0].id);
    for (const node of definition.nodes) if (!reachable.has(node.id)) errors.push(`Node ${node.id} is not reachable from the trigger`);

    for (const node of definition.nodes) {
        const nodeEdges = definition.edges.filter(edge => edge.source === node.id);
        if (node.type === 'condition.filter') {
            if (!nodeEdges.some(edge => edge.sourceHandle === 'true') || !nodeEdges.some(edge => edge.sourceHandle === 'false')) {
                errors.push(`Condition node ${node.id} requires both true and false branches`);
            }
        } else if (node.type === 'condition.switch') {
            const cases = Array.isArray(node.config?.cases) ? node.config.cases as Record<string, unknown>[] : [];
            const requiredHandles = [...cases.map(item => String(item.id)), 'default'];
            if (requiredHandles.some(handle => !nodeEdges.some(edge => (edge.sourceHandle || 'default') === handle))) {
                errors.push(`Switch node ${node.id} requires an edge for every case and the default branch`);
            }
        } else if (!['action.reject', 'action.stop'].includes(node.type) && nodeEdges.length === 0) {
            errors.push(`Node ${node.id} requires a next node`);
        }
    }

    if (!hasDurableBinding && definition.nodes.some(node => DURABLE.has(node.type))) {
        errors.push('Processing, Delay, and Webhook nodes require the EMAIL_WORKFLOW binding');
    }

    // SMTP-native actions cannot be replayed after a durable delay.
    const invalidAfterDurable = new Set<string>();
    const durableVisits = new Set<string>();
    const walkDurable = (id: string, seenDurable: boolean) => {
        const visitKey = `${id}:${seenDurable}`;
        if (durableVisits.has(visitKey)) return;
        durableVisits.add(visitKey);
        const node = definition.nodes.find(item => item.id === id);
        if (!node) return;
        const nextSeenDurable = seenDurable || DURABLE.has(node.type);
        if (nextSeenDurable && SYNC_ONLY.has(node.type)) invalidAfterDurable.add(node.id);
        for (const target of adjacency.get(id) || []) walkDurable(target, nextSeenDurable);
    };
    if (triggers[0]) walkDurable(triggers[0].id, false);
    if (invalidAfterDurable.size) errors.push('Forward, auto-reply, and reject nodes must run before durable nodes');

    return { valid: errors.length === 0, errors };
}

export const isSyncOnlyNode = (type: WorkflowNodeType) => SYNC_ONLY.has(type);
