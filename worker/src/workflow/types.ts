export type WorkflowNodeType =
    | 'trigger.received'
    | 'condition.filter'
    | 'condition.switch'
    | 'process.extract'
    | 'process.delay'
    | 'action.webhook'
    | 'action.forward'
    | 'action.auto_reply'
    | 'action.reject'
    | 'action.stop';

export type WorkflowOperator =
    | 'equals' | 'not_equals' | 'contains' | 'not_contains'
    | 'starts_with' | 'ends_with' | 'matches' | 'exists';

export type WorkflowField =
    | 'from' | 'to' | 'subject' | 'text' | 'html'
    | 'messageId' | 'hasAttachments' | 'attachmentCount'
    | 'extract.type' | 'extract.result' | 'extract.result_text' | 'extract.source';

export type WorkflowNode = {
    id: string;
    type: WorkflowNodeType;
    name?: string;
    position?: { x: number; y: number };
    config?: Record<string, unknown>;
};

export type WorkflowEdge = {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
};

export type WorkflowDefinition = {
    version: 1;
    skipDefaultActions?: boolean;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
};

export type WorkflowRecord = {
    id: number;
    name: string;
    description: string;
    enabled: number;
    priority: number;
    definition: string | WorkflowDefinition;
    created_at: string;
    updated_at: string;
};

export type WorkflowMail = {
    mailId?: number;
    messageId: string | null;
    from: string;
    to: string;
    raw: string;
    subject: string;
    text: string;
    html: string;
    attachmentCount: number;
    extract?: { type: string; result: string; result_text?: string; source?: string } | null;
};

export type WorkflowParams = {
    workflowId: number;
    runId: string;
    mailId: number;
    startNodeIds: string[];
};

export type WorkflowValidationResult = {
    valid: boolean;
    errors: string[];
};
