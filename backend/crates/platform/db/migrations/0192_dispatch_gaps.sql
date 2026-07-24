-- CAP-DISPATCH-CONSOLE bounded queue lens.  Dispatch remains a work-order
-- lens; this is intentionally a read-path index only (no synthetic dispatch
-- object, vehicle, completion, cost, or voucher state).
--
-- Tenant first keeps a large multi-tenant plan local; the active-state
-- predicate is exactly the server-authoritative queue subset.
CREATE INDEX idx_work_orders_dispatch_queue_active
    ON work_orders (org_id, target_due_at ASC NULLS LAST, updated_at DESC, id ASC)
    WHERE status IN (
        'RECEIVED', 'UNASSIGNED', 'ASSIGNED', 'IN_PROGRESS', 'PART_WAITING', 'DELAYED'
    );
