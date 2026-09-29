# Email Workflows

Email workflows define how incoming messages are processed. Administrators can create workflows on a visual canvas, test them, and inspect run history from the Workflows page in the Admin console.

## Nodes

- Trigger: email received. Every workflow must contain exactly one trigger.
- Condition: branch on sender, recipient, subject, body, attachments, or extraction results using equality, substring, prefix, suffix, or regular-expression matching.
- Switch: configure 1–10 ordered cases for one field. The first matching case runs; the default branch runs when none match, making it practical to handle multiple email categories in one workflow.
- Processing: configurable extraction and durable delays. Extraction can read the subject, sender, recipient, plain-text body, HTML body, raw email, or combined subject and body. It supports the project's existing smart code/link extraction as well as custom regular expressions and capture groups.
- Actions: webhook, forwarding, automatic reply, reject, and stop workflow.

Extraction results are exposed as `extract.type`, `extract.result`, and `extract.result_text` for later conditions and webhook templates. Webhook templates use double-brace variables for fields such as `subject`, `text`, and `extract.result`. Requests include `X-Workflow-Run-Id` and `X-Workflow-Node-Id`, which receivers can use for idempotency.

## Deployment

Apply `db/2026-09-29-workflows.sql`, or run the database migration from the Admin console. Then add the durable workflow binding to the Worker's `wrangler.toml`:

```toml
[[workflows]]
name = "email-workflow"
binding = "EMAIL_WORKFLOW"
class_name = "EmailWorkflow"
```

Without this binding, only synchronous workflows made of conditions, forwarding, automatic replies, rejection, and stop nodes can be saved. Delay, extraction, and webhook nodes require the binding.

Forward, automatic reply, and reject actions depend on the live SMTP session and must precede every durable node. The server rejects cycles, unreachable nodes, and invalid action ordering.

Every Switch case and its default must connect to a next node. Case order defines match priority; when several cases match, only the first one runs.

## Execution and retries

Enabled workflows run from highest to lowest priority. External actions retry twice by default, configurable from zero to five retries per node. Delays can last up to 30 days. Runs and node outputs are stored in D1 and shown in the Admin console.

Run history supports individual deletion and checkbox-based bulk deletion of up to 100 records. Deleting a run also deletes all of its node records. Running records cannot be deleted.

Webhooks use at-least-once delivery. In rare cases, the receiver may accept a request before the result is recorded, causing a retry to deliver it again. Receivers should deduplicate using the attached run and node IDs.

By default, workflows supplement the existing incoming-mail pipeline. Enable “Skip the legacy pipeline” to run only workflow-defined actions; the email is still stored normally.

Test runs use the selected email ID, or the latest stored email when it is empty. Tests do not execute forwarding, automatic replies, or rejection because those actions require the original SMTP session.
