import { Context } from 'hono';
import { parseWorkflowDefinition, validateWorkflowDefinition } from '../workflow/validation';
import type { WorkflowRecord } from '../workflow/types';

const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;

const serialize = (row: WorkflowRecord) => ({
    ...row,
    enabled: Boolean(row.enabled),
    definition: parseWorkflowDefinition(row.definition),
});

const readBody = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return { error: 'Invalid JSON body' } as const;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const priority = Number(body.priority ?? 0);
    if (!name || name.length > MAX_NAME) return { error: `Name must be 1-${MAX_NAME} characters` } as const;
    if (description.length > MAX_DESCRIPTION) return { error: `Description cannot exceed ${MAX_DESCRIPTION} characters` } as const;
    if (!Number.isSafeInteger(priority) || priority < -1000 || priority > 1000) return { error: 'Priority must be an integer between -1000 and 1000' } as const;
    const validation = validateWorkflowDefinition(body.definition, Boolean(c.env.EMAIL_WORKFLOW));
    if (!validation.valid) return { error: validation.errors.join('; ') } as const;
    return {
        value: { name, description, priority, enabled: body.enabled === true ? 1 : 0, definition: JSON.stringify(body.definition) }
    } as const;
};

const list = async (c: Context<HonoCustomType>) => {
    const result = await c.env.DB.prepare(`SELECT w.*,
        (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id=w.id) AS run_count,
        (SELECT status FROM workflow_runs r WHERE r.workflow_id=w.id ORDER BY started_at DESC LIMIT 1) AS last_status
        FROM workflows w ORDER BY priority DESC,id ASC`).all<WorkflowRecord>();
    return c.json(result.results.map(serialize));
};

const get = async (c: Context<HonoCustomType>) => {
    const row = await c.env.DB.prepare(`SELECT * FROM workflows WHERE id=?`).bind(c.req.param('id')).first<WorkflowRecord>();
    return row ? c.json(serialize(row)) : c.text('Workflow not found', 404);
};

const create = async (c: Context<HonoCustomType>) => {
    const parsed = await readBody(c);
    if ('error' in parsed) return c.text(parsed.error || 'Invalid workflow', 400);
    const value = parsed.value;
    const result = await c.env.DB.prepare(`INSERT INTO workflows(name,description,enabled,priority,definition)
        VALUES(?,?,?,?,?)`).bind(value.name, value.description, value.enabled, value.priority, value.definition).run();
    const row = await c.env.DB.prepare(`SELECT * FROM workflows WHERE id=?`).bind(result.meta.last_row_id).first<WorkflowRecord>();
    return c.json(serialize(row!), 201);
};

const update = async (c: Context<HonoCustomType>) => {
    const parsed = await readBody(c);
    if ('error' in parsed) return c.text(parsed.error || 'Invalid workflow', 400);
    const value = parsed.value;
    const result = await c.env.DB.prepare(`UPDATE workflows SET name=?,description=?,enabled=?,priority=?,definition=?,updated_at=datetime('now') WHERE id=?`)
        .bind(value.name, value.description, value.enabled, value.priority, value.definition, c.req.param('id')).run();
    if (!result.meta.changes) return c.text('Workflow not found', 404);
    return get(c);
};

const remove = async (c: Context<HonoCustomType>) => {
    const id = c.req.param('id');
    const active = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id=? AND status='running'`)
        .bind(id).first<number>('count');
    if (active) return c.text('Cannot delete a workflow with running instances', 409);
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM workflow_run_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id=?)`).bind(id),
        c.env.DB.prepare(`DELETE FROM workflow_runs WHERE workflow_id=?`).bind(id),
        c.env.DB.prepare(`DELETE FROM workflows WHERE id=?`).bind(id),
    ]);
    return c.json({ success: true });
};

const runs = async (c: Context<HonoCustomType>) => {
    const workflowId = c.req.query('workflow_id');
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
    const query = workflowId
        ? c.env.DB.prepare(`SELECT r.*,w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?`).bind(workflowId, limit)
        : c.env.DB.prepare(`SELECT r.*,w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id ORDER BY started_at DESC LIMIT ?`).bind(limit);
    return c.json((await query.all()).results);
};

const runDetail = async (c: Context<HonoCustomType>) => {
    const run = await c.env.DB.prepare(`SELECT r.*,w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.id=?`)
        .bind(c.req.param('run_id')).first();
    if (!run) return c.text('Workflow run not found', 404);
    const steps = (await c.env.DB.prepare(`SELECT * FROM workflow_run_steps WHERE run_id=? ORDER BY id ASC`).bind(c.req.param('run_id')).all()).results;
    return c.json({ ...run, steps });
};

const readRunIds = async (c: Context<HonoCustomType>): Promise<string[] | null> => {
    const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
    if (!body || !Array.isArray(body.ids)) return null;
    const ids = [...new Set(body.ids.filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))];
    return ids.length >= 1 && ids.length <= 100 ? ids : null;
};

const deleteRunsByIds = async (c: Context<HonoCustomType>, ids: string[]) => {
    const placeholders = ids.map(() => '?').join(',');
    const existing = (await c.env.DB.prepare(
        `SELECT id,status FROM workflow_runs WHERE id IN (${placeholders})`
    ).bind(...ids).all<{ id: string; status: string }>()).results;
    if (existing.length !== ids.length) return c.text('One or more workflow runs were not found', 404);
    if (existing.some(run => run.status === 'running')) return c.text('Running workflow records cannot be deleted', 409);
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM workflow_run_steps WHERE run_id IN (${placeholders})`).bind(...ids),
        c.env.DB.prepare(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`).bind(...ids),
    ]);
    return c.json({ success: true, deleted: ids.length });
};

const removeRun = async (c: Context<HonoCustomType>) => deleteRunsByIds(c, [c.req.param('run_id')]);

const removeRuns = async (c: Context<HonoCustomType>) => {
    const ids = await readRunIds(c);
    if (!ids) return c.text('ids must contain 1 to 100 unique workflow run IDs', 400);
    return deleteRunsByIds(c, ids);
};

const test = async (c: Context<HonoCustomType>) => {
    if (!c.env.EMAIL_WORKFLOW) return c.text('EMAIL_WORKFLOW binding is not configured', 400);
    const workflowId = Number(c.req.param('id'));
    const body: { mail_id?: number } = await c.req.json<{ mail_id?: number }>().catch(() => ({}));
    const record = await c.env.DB.prepare(`SELECT id FROM workflows WHERE id=?`).bind(workflowId).first();
    if (!record) return c.text('Workflow not found', 404);
    const mail = body.mail_id
        ? await c.env.DB.prepare(`SELECT id,message_id FROM raw_mails WHERE id=?`).bind(body.mail_id).first<{ id: number; message_id: string }>()
        : await c.env.DB.prepare(`SELECT id,message_id FROM raw_mails ORDER BY id DESC LIMIT 1`).first<{ id: number; message_id: string }>();
    if (!mail) return c.text('No email is available for the test', 400);
    const runId = crypto.randomUUID();
    const workflow = await c.env.DB.prepare(`SELECT definition FROM workflows WHERE id=?`).bind(workflowId).first<{ definition: string }>();
    const definition = parseWorkflowDefinition(workflow?.definition);
    const trigger = definition?.nodes.find(node => node.type === 'trigger.received');
    if (!definition || !trigger) return c.text('Invalid workflow definition', 400);
    const startNodeIds = definition.edges.filter(edge => edge.source === trigger.id).map(edge => edge.target);
    await c.env.DB.prepare(`INSERT INTO workflow_runs(id,workflow_id,mail_id,message_id,definition,status) VALUES(?,?,?,?,?,'running')`)
        .bind(runId, workflowId, mail.id, mail.message_id || null, workflow!.definition).run();
    try {
        await c.env.EMAIL_WORKFLOW.create({ id: runId, params: { workflowId, runId, mailId: mail.id, startNodeIds } });
    } catch (error) {
        await c.env.DB.prepare(`UPDATE workflow_runs SET status='failed',finished_at=datetime('now'),error=? WHERE id=?`)
            .bind(`Failed to start workflow: ${String(error)}`, runId).run();
        throw error;
    }
    return c.json({ success: true, runId });
};

export default { list, get, create, update, remove, runs, runDetail, removeRun, removeRuns, test };
