import { createMimeMessage } from 'mimetext';
import { commonParseMail } from '../common';
import { normalizeAddressDomain } from '../utils';
import { isSyncOnlyNode, parseWorkflowDefinition, validateWorkflowDefinition } from './validation';
import { matches, outgoing } from './runtime';
import { selectWorkflowSwitchBranch } from './evaluation';
import type { WorkflowDefinition, WorkflowMail, WorkflowNode, WorkflowRecord } from './types';

const parseDefinition = (record: WorkflowRecord): WorkflowDefinition | null =>
    parseWorkflowDefinition(record.definition);

async function executeReply(message: ForwardableEmailMessage, to: string, node: WorkflowNode) {
    const messageId = message.headers.get('Message-ID');
    if (!messageId) return;
    const config = node.config || {};
    const mime = createMimeMessage();
    mime.setHeader('In-Reply-To', messageId);
    mime.setSender({ name: String(config.fromName || to), addr: to });
    mime.setRecipient(message.from);
    mime.setSubject(String(config.subject || 'Auto-reply'));
    mime.addMessage({ contentType: 'text/plain', data: String(config.body || 'This is an automatic reply.') });
    const { EmailMessage } = await import('cloudflare:email');
    await message.reply(new EmailMessage(to, message.from, mime.asRaw()));
}

async function runSyncNodes(
    env: Bindings,
    runId: string,
    message: ForwardableEmailMessage,
    definition: WorkflowDefinition,
    mail: WorkflowMail,
): Promise<{ deferred: string[]; rejected: boolean; stopped: boolean }> {
    const trigger = definition.nodes.find(node => node.type === 'trigger.received');
    if (!trigger) return { deferred: [], rejected: false, stopped: true };
    const queue = outgoing(definition, trigger);
    const visited = new Set<string>();
    const deferred: string[] = [];
    while (queue.length) {
        const nodeId = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        const node = definition.nodes.find(item => item.id === nodeId);
        if (!node) continue;
        const started = Date.now();
        if (node.type === 'condition.filter') {
            const branch = matches(mail, node.config || {}) ? 'true' : 'false';
            await env.DB.prepare(`INSERT INTO workflow_run_steps(run_id,node_id,node_type,status,finished_at,duration_ms,output) VALUES(?,?,?,'completed',datetime('now'),?,?)`)
                .bind(runId, node.id, node.type, Date.now() - started, JSON.stringify({ branch })).run();
            queue.push(...outgoing(definition, node, branch));
            continue;
        }
        if (node.type === 'condition.switch') {
            const branch = selectWorkflowSwitchBranch(mail, node.config || {});
            await env.DB.prepare(`INSERT INTO workflow_run_steps(run_id,node_id,node_type,status,finished_at,duration_ms,output) VALUES(?,?,?,'completed',datetime('now'),?,?)`)
                .bind(runId, node.id, node.type, Date.now() - started, JSON.stringify({ branch })).run();
            queue.push(...outgoing(definition, node, branch));
            continue;
        }
        if (!isSyncOnlyNode(node.type) && node.type !== 'action.stop') {
            deferred.push(node.id);
            continue;
        }
        if (node.type === 'action.reject') {
            message.setReject(String(node.config?.reason || 'Rejected by workflow'));
            await env.DB.prepare(`INSERT INTO workflow_run_steps(run_id,node_id,node_type,status,finished_at,duration_ms) VALUES(?,?,?,'completed',datetime('now'),?)`)
                .bind(runId, node.id, node.type, Date.now() - started).run();
            return { deferred, rejected: true, stopped: true };
        }
        if (node.type === 'action.forward') {
            const address = String(node.config?.address || '').trim();
            if (address) await message.forward(address);
        }
        if (node.type === 'action.auto_reply') await executeReply(message, mail.to, node);
        await env.DB.prepare(`INSERT INTO workflow_run_steps(run_id,node_id,node_type,status,finished_at,duration_ms) VALUES(?,?,?,'completed',datetime('now'),?)`)
            .bind(runId, node.id, node.type, Date.now() - started).run();
        if (node.type === 'action.stop') continue;
        queue.push(...outgoing(definition, node));
    }
    return { deferred, rejected: false, stopped: deferred.length === 0 };
}

export async function prepareEmailWorkflows(message: ForwardableEmailMessage, env: Bindings, raw: string) {
    let records: WorkflowRecord[] = [];
    try {
        records = (await env.DB.prepare(`SELECT * FROM workflows WHERE enabled = 1 ORDER BY priority DESC,id ASC`).all<WorkflowRecord>()).results;
    } catch (error) {
        // Supports upgrades before the optional migration is applied.
        if (!String(error).includes('no such table')) console.error('load workflows error', error);
        return { rejected: false, skipDefaultActions: false, runIds: [] as string[], pending: [] as { record: WorkflowRecord; runId: string; startNodeIds: string[] }[] };
    }
    if (!records.length) return { rejected: false, skipDefaultActions: false, runIds: [] as string[], pending: [] as { record: WorkflowRecord; runId: string; startNodeIds: string[] }[] };
    const parsed = await commonParseMail({ rawEmail: raw });
    const mail: WorkflowMail = {
        messageId: message.headers.get('Message-ID'), from: parsed?.sender || message.from,
        to: normalizeAddressDomain(message.to), raw, subject: parsed?.subject || '', text: parsed?.text || '',
        html: parsed?.html || '', attachmentCount: parsed?.attachments?.length || 0,
    };
    const pending = [];
    const runIds: string[] = [];
    let skipDefaultActions = false;
    for (const record of records) {
        const definition = parseDefinition(record);
        if (!definition || !validateWorkflowDefinition(definition).valid) {
            console.error('Skipping invalid email workflow definition', record.id);
            continue;
        }
        skipDefaultActions ||= definition.skipDefaultActions === true;
        const runId = crypto.randomUUID();
        runIds.push(runId);
        await env.DB.prepare(`INSERT INTO workflow_runs(id,workflow_id,message_id,definition,status) VALUES(?,?,?,?,'running')`)
            .bind(runId, record.id, mail.messageId, typeof record.definition === 'string' ? record.definition : JSON.stringify(record.definition)).run();
        try {
            const result = await runSyncNodes(env, runId, message, definition, mail);
            if (result.rejected) {
                await env.DB.prepare(`UPDATE workflow_runs SET status='stopped',finished_at=datetime('now') WHERE id=?`).bind(runId).run();
                await Promise.all(pending.map(item => env.DB.prepare(
                    `UPDATE workflow_runs SET status='stopped',finished_at=datetime('now'),error='Email rejected by a later workflow' WHERE id=?`
                ).bind(item.runId).run()));
                return { rejected: true, skipDefaultActions, runIds, pending };
            }
            if (result.deferred.length) pending.push({ record, runId, startNodeIds: result.deferred });
            else await env.DB.prepare(`UPDATE workflow_runs SET status='completed',finished_at=datetime('now') WHERE id=?`).bind(runId).run();
        } catch (error) {
            await env.DB.prepare(`UPDATE workflow_runs SET status='failed',finished_at=datetime('now'),error=? WHERE id=?`)
                .bind(String(error), runId).run();
        }
    }
    return { rejected: false, skipDefaultActions, runIds, pending };
}

export async function startPendingWorkflows(env: Bindings, mailId: number, runIds: string[], pending: { record: WorkflowRecord; runId: string; startNodeIds: string[] }[]) {
    if (runIds.length) {
        await Promise.all(runIds.map(runId => env.DB.prepare(`UPDATE workflow_runs SET mail_id=? WHERE id=?`).bind(mailId, runId).run()));
    }
    for (const item of pending) {
        if (!env.EMAIL_WORKFLOW) {
            await env.DB.prepare(`UPDATE workflow_runs SET status='failed',finished_at=datetime('now'),error=? WHERE id=?`)
                .bind('EMAIL_WORKFLOW binding is not configured', item.runId).run();
            continue;
        }
        try {
            await env.EMAIL_WORKFLOW.create({
                id: item.runId,
                params: { workflowId: item.record.id, runId: item.runId, mailId, startNodeIds: item.startNodeIds },
            });
        } catch (error) {
            await env.DB.prepare(`UPDATE workflow_runs SET status='failed',finished_at=datetime('now'),error=? WHERE id=?`)
                .bind(`Failed to start workflow: ${String(error)}`, item.runId).run();
            console.error('Failed to start email workflow', item.runId, error);
        }
    }
}
