import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflowDefinition } from './validation.ts';
import { extractWorkflowPattern, getWorkflowExtractSource, isPrivateWebhookHost, matchesWorkflowCondition as matches, renderWorkflowTemplate as render, selectWorkflowSwitchBranch } from './evaluation.ts';

const mail = {
    messageId: '<1@example.com>', from: 'alerts@example.com', to: 'box@example.net', raw: '',
    subject: 'Your code is 123456', text: 'Production alert', html: '', attachmentCount: 1,
    extract: { type: 'auth_code', result: '123456' },
};

const definition = (nodes, edges) => ({ version: 1, nodes: [
    { id: 'trigger', type: 'trigger.received', config: {} }, ...nodes,
], edges });

test('validates a branching acyclic graph', () => {
    const result = validateWorkflowDefinition(definition(
        [{ id: 'filter', type: 'condition.filter', config: { field: 'subject', operator: 'contains', value: 'code' } }, { id: 'yes', type: 'action.stop' }, { id: 'no', type: 'action.stop' }],
        [{ id: 'a', source: 'trigger', target: 'filter' }, { id: 'b', source: 'filter', target: 'yes', sourceHandle: 'true' }, { id: 'c', source: 'filter', target: 'no', sourceHandle: 'false' }],
    ));
    assert.equal(result.valid, true);
});

test('allows multiple branches to share one stop node only', () => {
    const sharedStop = validateWorkflowDefinition(definition(
        [{ id: 'filter', type: 'condition.filter', config: { field: 'subject', operator: 'contains', value: 'code' } }, { id: 'stop', type: 'action.stop' }],
        [{ id: 'a', source: 'trigger', target: 'filter' }, { id: 'b', source: 'filter', target: 'stop', sourceHandle: 'true' }, { id: 'c', source: 'filter', target: 'stop', sourceHandle: 'false' }],
    ));
    assert.equal(sharedStop.valid, true);

    const sharedAction = definition(
        [{ id: 'filter', type: 'condition.filter', config: { field: 'subject', operator: 'contains', value: 'code' } }, { id: 'hook', type: 'action.webhook', config: { url: 'https://example.com', method: 'POST', headers: '{}' } }, { id: 'stop', type: 'action.stop' }],
        [{ id: 'a', source: 'trigger', target: 'filter' }, { id: 'b', source: 'filter', target: 'hook', sourceHandle: 'true' }, { id: 'c', source: 'filter', target: 'hook', sourceHandle: 'false' }, { id: 'd', source: 'hook', target: 'stop' }],
    );
    assert.match(validateWorkflowDefinition(sharedAction).errors.join(' '), /only one incoming edge/);
});

test('rejects cycles and unreachable nodes', () => {
    const result = validateWorkflowDefinition(definition(
        [{ id: 'a', type: 'action.stop' }, { id: 'orphan', type: 'action.stop' }],
        [{ id: 'one', source: 'trigger', target: 'a' }, { id: 'two', source: 'a', target: 'trigger' }],
    ));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /cycle|cycles/);
    assert.match(result.errors.join(' '), /orphan/);
});

test('requires durable binding and keeps SMTP actions before durable nodes', () => {
    const graph = definition(
        [{ id: 'delay', type: 'process.delay', config: { seconds: 10 } }, { id: 'forward', type: 'action.forward', config: { address: 'a@example.com' } }],
        [{ id: 'one', source: 'trigger', target: 'delay' }, { id: 'two', source: 'delay', target: 'forward' }],
    );
    assert.match(validateWorkflowDefinition(graph, false).errors.join(' '), /EMAIL_WORKFLOW/);
    assert.match(validateWorkflowDefinition(graph, true).errors.join(' '), /must run before durable/);
});

test('rejects branch handles on non-condition nodes', () => {
    const result = validateWorkflowDefinition(definition(
        [{ id: 'stop', type: 'action.stop' }],
        [{ id: 'one', source: 'trigger', target: 'stop', sourceHandle: 'true' }],
    ));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /default branch/);
});

test('validates retry, timeout, and webhook request settings', () => {
    const result = validateWorkflowDefinition(definition(
        [{ id: 'hook', type: 'action.webhook', config: {
            url: 'https://example.com/hook', method: 'TRACE', headers: '[]',
            retryLimit: 1.5, retryDelaySeconds: 0, timeoutSeconds: 301,
        } }, { id: 'stop', type: 'action.stop' }],
        [{ id: 'one', source: 'trigger', target: 'hook' }, { id: 'two', source: 'hook', target: 'stop' }],
    ));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /retry limit/);
    assert.match(result.errors.join(' '), /retry delay/);
    assert.match(result.errors.join(' '), /timeout/);
    assert.match(result.errors.join(' '), /Webhook/);
});

test('validates configurable extraction sources and regular expressions', () => {
    const valid = definition(
        [{ id: 'extract', type: 'process.extract', config: { mode: 'regex', source: 'subject', pattern: 'code: (\\d+)', captureGroup: 1, resultType: 'order_code' } }, { id: 'stop', type: 'action.stop' }],
        [{ id: 'one', source: 'trigger', target: 'extract' }, { id: 'two', source: 'extract', target: 'stop' }],
    );
    assert.equal(validateWorkflowDefinition(valid).valid, true);
    valid.nodes[1].config.source = 'attachment';
    valid.nodes[1].config.pattern = '[';
    assert.equal(validateWorkflowDefinition(valid).valid, false);
    assert.equal(getWorkflowExtractSource(mail, 'subject'), 'Your code is 123456');
    assert.equal(getWorkflowExtractSource(mail, 'from'), 'alerts@example.com');
    assert.equal(extractWorkflowPattern('Order: AB-123', 'order: ([a-z]+-\\d+)', 1, false), 'AB-123');
});

test('validates and evaluates ordered switch branches with a default', () => {
    const graph = definition(
        [{ id: 'switch', type: 'condition.switch', config: { field: 'from', cases: [
            { id: 'billing', label: 'Billing', operator: 'contains', value: 'billing@' },
            { id: 'alerts', label: 'Alerts', operator: 'contains', value: 'alerts@' },
        ] } }, { id: 'billing-stop', type: 'action.stop' }, { id: 'alerts-stop', type: 'action.stop' }, { id: 'other-stop', type: 'action.stop' }],
        [{ id: 'one', source: 'trigger', target: 'switch' },
            { id: 'two', source: 'switch', target: 'billing-stop', sourceHandle: 'billing' },
            { id: 'three', source: 'switch', target: 'alerts-stop', sourceHandle: 'alerts' },
            { id: 'four', source: 'switch', target: 'other-stop', sourceHandle: 'default' }],
    );
    assert.equal(validateWorkflowDefinition(graph).valid, true);
    assert.equal(selectWorkflowSwitchBranch(mail, graph.nodes[1].config), 'alerts');
    assert.equal(selectWorkflowSwitchBranch({ ...mail, from: 'someone@example.com' }, graph.nodes[1].config), 'default');

    graph.nodes[1].config.cases[0].id = 'default';
    assert.equal(validateWorkflowDefinition(graph).valid, false);
});

test('evaluates filters and templates', () => {
    assert.equal(matches(mail, { field: 'subject', operator: 'contains', value: '123456' }), true);
    assert.equal(matches(mail, { field: 'hasAttachments', operator: 'equals', value: true }), true);
    assert.equal(matches(mail, { field: 'from', operator: 'matches', value: '@example\\.com$' }), true);
    assert.equal(matches(mail, { field: 'from', operator: 'matches', value: 'x'.repeat(201) }), false);
    assert.equal(render('{{from}}:{{extract.result}}', mail), 'alerts@example.com:123456');
});

test('blocks private webhook hosts without rejecting public names with similar prefixes', () => {
    assert.equal(isPrivateWebhookHost('127.0.0.1'), true);
    assert.equal(isPrivateWebhookHost('[fd00::1]'), true);
    assert.equal(isPrivateWebhookHost('service.local'), true);
    assert.equal(isPrivateWebhookHost('fca.example.com'), false);
});
