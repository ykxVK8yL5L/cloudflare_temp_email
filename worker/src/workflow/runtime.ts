import { commonParseMail, sendWebhook } from '../common';
import { resolveRawEmail } from '../gzip';
import { extractEmailInfo, saveExtractMetadata } from '../email/ai_extract';
import { parseWorkflowDefinition } from './validation';
import type { WorkflowDefinition, WorkflowEdge, WorkflowMail, WorkflowNode, WorkflowRecord } from './types';
import { extractWorkflowPattern, getWorkflowExtractSource, isPrivateWebhookHost, matchesWorkflowCondition as matches, renderWorkflowTemplate as render, selectWorkflowSwitchBranch } from './evaluation';

type StepRunner = {
    do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
};

const outgoing = (definition: WorkflowDefinition, node: WorkflowNode, branch = 'default') =>
    definition.edges
        .filter(edge => edge.source === node.id && (edge.sourceHandle || 'default') === branch)
        .map(edge => edge.target);

async function loadMail(env: Bindings, mailId: number): Promise<WorkflowMail> {
    const row = await env.DB.prepare(`SELECT * FROM raw_mails WHERE id = ?`).bind(mailId).first<any>();
    if (!row) throw new Error(`Mail ${mailId} not found`);
    const raw = await resolveRawEmail(row);
    const context: ParsedEmailContext = { rawEmail: raw };
    const parsed = await commonParseMail(context);
    let extract = null;
    try { extract = JSON.parse(row.metadata || '{}')?.ai_extract || null; } catch { /* invalid legacy metadata */ }
    return {
        mailId, messageId: row.message_id || null, from: parsed?.sender || row.source || '',
        to: row.address || '', raw, subject: parsed?.subject || '', text: parsed?.text || '',
        html: parsed?.html || '', attachmentCount: parsed?.attachments?.length || 0, extract,
    };
}

async function beginStep(env: Bindings, runId: string, node: WorkflowNode) {
    await env.DB.prepare(`INSERT INTO workflow_run_steps
        (run_id,node_id,node_type,status,started_at,attempt) VALUES(?,?,?,'running',datetime('now'),1)
        ON CONFLICT(run_id,node_id) DO UPDATE SET status='running',started_at=datetime('now'),
        finished_at=NULL,duration_ms=NULL,output=NULL,error=NULL,attempt=workflow_run_steps.attempt+1`)
        .bind(runId, node.id, node.type).run();
}

async function finishStep(env: Bindings, runId: string, node: WorkflowNode, status: string, started: number, output?: unknown, error?: unknown) {
    await env.DB.prepare(`UPDATE workflow_run_steps SET status=?,finished_at=datetime('now'),duration_ms=?,output=?,error=? WHERE run_id=? AND node_id=?`)
        .bind(status, Date.now() - started, output === undefined ? null : JSON.stringify(output), error ? String(error) : null, runId, node.id).run();
}

async function executeDurableNode(env: Bindings, runId: string, node: WorkflowNode, mail: WorkflowMail): Promise<{ branch: string; output?: unknown; stop?: boolean }> {
    const config = node.config || {};
    if (node.type === 'condition.filter') return { branch: matches(mail, config) ? 'true' : 'false' };
    if (node.type === 'condition.switch') return { branch: selectWorkflowSwitchBranch(mail, config) };
    if (node.type === 'process.extract') {
        const source = String(config.source || 'subject_text');
        const sourceContent = getWorkflowExtractSource(mail, source);
        let result: WorkflowMail['extract'];
        if (config.mode === 'regex') {
            result = {
                type: String(config.resultType || 'custom'),
                result: extractWorkflowPattern(sourceContent, config.pattern, config.captureGroup, config.caseSensitive),
                result_text: String(config.resultLabel || ''),
                source,
            };
            if (result.result) await saveExtractMetadata(env, mail.messageId, result as any);
        } else {
            const context: ParsedEmailContext = { rawEmail: mail.raw };
            const extracted = await extractEmailInfo(context, env, mail.messageId, mail.to, true, sourceContent);
            result = extracted ? { ...extracted, source } : null;
            if (result) await saveExtractMetadata(env, mail.messageId, result as any);
        }
        mail.extract = result;
        return { branch: 'default', output: result };
    }
    if (node.type === 'action.webhook') {
        const url = render(config.url, mail);
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Webhook URL must use HTTP(S)');
        if (isPrivateWebhookHost(parsedUrl.hostname)) throw new Error('Webhook URL cannot target a private network');
        let configuredHeaders: Record<string, string> = {};
        try { configuredHeaders = JSON.parse(render(config.headers || '{}', mail)); } catch { throw new Error('Webhook headers must be valid JSON'); }
        configuredHeaders['X-Workflow-Run-Id'] = runId;
        configuredHeaders['X-Workflow-Node-Id'] = node.id;
        const result = await sendWebhook({
            enabled: true, url, method: String(config.method || 'POST'),
            headers: JSON.stringify(configuredHeaders),
            body: render(config.body || '{}', mail),
        }, {
            id: String(mail.mailId || ''), url: '', attachments: [], from: mail.from, to: mail.to,
            subject: mail.subject, raw: mail.raw, parsedText: mail.text, parsedHtml: mail.html,
            aiExtract: mail.extract as any, aiExtractType: mail.extract?.type || '',
            aiExtractResult: mail.extract?.result || '', aiExtractResultText: mail.extract?.result_text || '',
        });
        if (!result.success) throw new Error(result.message || 'Webhook failed');
        return { branch: 'default', output: { delivered: true } };
    }
    if (node.type === 'action.forward' || node.type === 'action.auto_reply' || node.type === 'action.reject') {
        return { branch: 'default', output: { skipped: true, reason: 'Requires a live SMTP session' }, stop: node.type === 'action.reject' };
    }
    if (node.type === 'action.stop') return { branch: 'default', stop: true };
    return { branch: 'default' };
}

export async function executeDurableGraph(env: Bindings, params: { workflowId: number; runId: string; mailId: number; startNodeIds: string[] }, step: StepRunner) {
    try {
        const run = await env.DB.prepare(`SELECT definition FROM workflow_runs WHERE id = ? AND workflow_id = ?`).bind(params.runId, params.workflowId).first<{ definition: string }>();
        const definition = parseWorkflowDefinition(run?.definition);
        if (!definition) throw new Error('Workflow definition not found');
        const mail = await loadMail(env, params.mailId);
        const queue = [...params.startNodeIds];
        const visited = new Set<string>();
        while (queue.length) {
            const nodeId = queue.shift()!;
            if (visited.has(nodeId)) continue;
            visited.add(nodeId);
            const node = definition.nodes.find(item => item.id === nodeId);
            if (!node) continue;
            const nodeStarted = Date.now();
            try {
                if (node.type === 'process.delay') {
                    const seconds = Math.min(Math.max(Number(node.config?.seconds) || 1, 1), 2592000);
                    await step.do(`${node.id}: begin delay`, {}, async () => {
                        await beginStep(env, params.runId, node);
                        return { started: true };
                    });
                    await step.sleep(`${node.id}: delay`, seconds * 1000);
                    await finishStep(env, params.runId, node, 'completed', Date.now() - seconds * 1000, { seconds });
                    queue.push(...outgoing(definition, node));
                    continue;
                }
                const retryLimit = Math.min(Math.max(Number(node.config?.retryLimit ?? 2), 0), 5);
                const retryDelay = Math.min(Math.max(Number(node.config?.retryDelaySeconds) || 5, 1), 3600);
                const result = await step.do(`${node.id}: ${node.name || node.type}`, {
                    retries: { limit: retryLimit, delay: retryDelay * 1000, backoff: 'exponential' },
                    timeout: `${Math.min(Math.max(Number(node.config?.timeoutSeconds) || 30, 1), 300)} seconds`,
                }, async () => {
                    await beginStep(env, params.runId, node);
                    return executeDurableNode(env, params.runId, node, mail);
                });
                if (node.type === 'process.extract') {
                    mail.extract = (result.output as WorkflowMail['extract']) || null;
                }
                const skipped = Boolean(result.output && typeof result.output === 'object' && 'skipped' in result.output);
                await finishStep(env, params.runId, node, skipped ? 'skipped' : 'completed', nodeStarted, result.output);
                if (!result.stop) queue.push(...outgoing(definition, node, result.branch));
            } catch (error) {
                await finishStep(env, params.runId, node, 'failed', nodeStarted, undefined, error);
                throw error;
            }
        }
        await env.DB.prepare(`UPDATE workflow_runs SET status='completed',finished_at=datetime('now'),
            duration_ms=CAST((julianday('now')-julianday(started_at))*86400000 AS INTEGER) WHERE id=?`)
            .bind(params.runId).run();
    } catch (error) {
        await env.DB.prepare(`UPDATE workflow_runs SET status='failed',finished_at=datetime('now'),
            duration_ms=CAST((julianday('now')-julianday(started_at))*86400000 AS INTEGER),error=? WHERE id=?`)
            .bind(String(error), params.runId).run();
        throw error;
    }
}

export { loadMail, matches, outgoing, render };
