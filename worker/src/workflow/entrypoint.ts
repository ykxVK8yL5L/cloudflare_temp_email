import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { executeDurableGraph } from './runtime';
import type { WorkflowParams } from './types';

export class EmailWorkflow extends WorkflowEntrypoint<Bindings, WorkflowParams> {
    async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
        await executeDurableGraph(this.env, event.payload, step);
        return { runId: event.payload.runId };
    }
}
