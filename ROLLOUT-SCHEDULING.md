# Schedule editing and execution history: staged release

Not approved for production deployment yet. Work is isolated from main.

## Implemented

- Edit existing schedules via PUT, preserving IDs, owner and sent history.
- Load message, recipients, media, captions, timezone, recurrence and delays in editor.
- Reject edits/deletions for queued or sending schedules; stale edits rejected.
- Remove manual immediate-send frontend function, button and backend route.
- Store execution snapshots and per-recipient/media acceptance separately in executions.json.
- Client summary excludes diagnostics. Detailed endpoints require admin.
- Sanitized technical status/code and supported cause classification. Unknown causes remain unknown.
- Previous raw logs remain admin-only; their missing diagnostics cannot be recovered.
- A restarted queued/running execution becomes interrupted; it is never automatically replayed.
- Atomic database file replacement, avoiding a previously queued stale-snapshot write.

## Automated verification

Run: node --test test/scheduling.test.js

13 tests cover validation, identity preservation, quotas, persistence, authorization,
busy locks, stale forms, removing the immediate-send path, durable execution state,
mixed results, same-instance serialization and editor submission using a mocked DOM.
Syntax: node --check server.js; node --check public/app.js.

These are isolated tests with fake API responses, not a real WhatsApp/Evolution
integration test or full browser visual verification.

## Required before production

1. Deploy this branch to an isolated staging service with separate DB_FILE, USERS_FILE,
   upload directory and logs. Never point staging to customer instances or production files.
2. Validate create, edit, cancel edit, replace/remove/add media and recipients, save and
   reload in desktop/mobile browsers. Check a second tab with stale editing data.
3. Validate status filtering, date boundaries and client/admin permissions with separate accounts.
4. With a dedicated consenting test number/group, validate actual Evolution acceptance,
   partial media failure and disconnected state. Do not retry uncertain deliveries automatically.
5. Back up production database, users and uploads, and confirm the exact deployed revision.
6. Confirm there are NO queued or active sends and choose a quiet deployment window.
   The old process queue is in memory; deploying mid-send can lose queued work.
7. Persist executions.json beside DB_FILE on a volume. Run a single app process/replica.
8. Deploy as one release; smoke-test a dedicated test schedule, without contacting customers.
9. If reverting, restore previous code only in a quiet window. Do not blindly restore an
   old database over newly recorded sends; that can duplicate sends on rollback.

## Limits and operational considerations

- Acceptance by Evolution is not a delivery/read receipt.
- Old reports are incomplete for reconstruction (200 returned / 2000 retained logs).
- Execution retention/archiving is not yet automated. Monitor file growth before expanding usage.
- Runs are indexed by the schedule timezone at the start. Cross-midnight runs remain on
  their start date. The date selector uses the viewing browser's local date initially.
- Historical summaries do not recreate missing runs or fabricate exact failure causes.
- Diagnostic responses exclude raw provider payloads to avoid leaking secrets.
- Client summary polling happens every 10 seconds only on the open visible history page.
