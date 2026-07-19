import assert from "node:assert/strict";
import test from "node:test";

import type { components, operations } from "../src/schema.js";

type LeaveRequestView = components["schemas"]["LeaveRequestView"];
type LeaveRequestPage = components["schemas"]["LeaveRequestPage"];
type ActionInboxResponse = components["schemas"]["ActionInboxResponse"];

const leaveRequest = {
  id: "00000000-0000-0000-0000-000000000001",
  branch_id: "00000000-0000-0000-0000-000000000002",
  requester_user_id: "00000000-0000-0000-0000-000000000003",
  subject_employee_id: "00000000-0000-0000-0000-000000000004",
  leave_type: "annual",
  days: 1,
  charge_units: null,
  charge_state: "review_required",
  charge_review_reasons: ["missing_calendar"],
  request_version: 1,
  charge_version: 0,
  start_date: "2026-07-20",
  end_date: "2026-07-20",
  reason: "Annual leave",
  status: "pending",
  decided_by: null,
  decided_at: null,
  created_at: "2026-07-19T12:00:00Z",
} satisfies LeaveRequestView;

const leavePage = {
  items: [leaveRequest],
  next_cursor: null,
} satisfies LeaveRequestPage;

const actionPage = {
  items: [],
  total: 0,
  total_is_exact: true,
  next_cursor: null,
} satisfies ActionInboxResponse;

const getMyLeaveQuery = {
  limit: 100,
  cursor: "00000000-0000-0000-0000-000000000001",
} satisfies NonNullable<operations["getMyLeave"]["parameters"]["query"]>;

const listLeaveRequestsQuery = {
  status: "pending",
  limit: 100,
  cursor: "00000000-0000-0000-0000-000000000002",
} satisfies NonNullable<operations["listLeaveRequests"]["parameters"]["query"]>;

test("JSON round trip preserves a required null charge_units field", () => {
  const decoded = JSON.parse(JSON.stringify(leaveRequest)) as LeaveRequestView;

  assert.equal(decoded.charge_units, null);
  assert.equal(Object.hasOwn(decoded, "charge_units"), true);
  assert.equal(JSON.parse(JSON.stringify(decoded)).charge_units, null);
});

test("generated type keeps days required and non-null", () => {
  const days: number = leaveRequest.days;

  assert.equal(days, 1);
});

test("generated pagination contracts preserve required null cursors", () => {
  const decodedLeavePage = JSON.parse(
    JSON.stringify(leavePage),
  ) as LeaveRequestPage;
  const decodedActionPage = JSON.parse(
    JSON.stringify(actionPage),
  ) as ActionInboxResponse;

  assert.equal(Object.hasOwn(decodedLeavePage, "next_cursor"), true);
  assert.equal(decodedLeavePage.next_cursor, null);
  assert.equal(Object.hasOwn(decodedActionPage, "next_cursor"), true);
  assert.equal(decodedActionPage.next_cursor, null);
});

test("generated leave operation queries expose both cursors", () => {
  assert.equal(getMyLeaveQuery.cursor, "00000000-0000-0000-0000-000000000001");
  assert.equal(
    listLeaveRequestsQuery.cursor,
    "00000000-0000-0000-0000-000000000002",
  );
});

// Compile-time contract: a required compatibility field cannot be omitted.
// @ts-expect-error LeaveRequestView.days is required.
const missingDays: LeaveRequestView = (({ days: _days, ...rest }) => rest)(
  leaveRequest,
);
void missingDays;

// Compile-time contract: a required-null field must still be present.
// @ts-expect-error LeaveRequestView.charge_units is required even when null.
const missingChargeUnits: LeaveRequestView = (({
  charge_units: _chargeUnits,
  ...rest
}) => rest)(leaveRequest);
void missingChargeUnits;

// @ts-expect-error LeaveRequestPage.next_cursor is required even when null.
const missingLeaveNextCursor: LeaveRequestPage = { items: [] };
void missingLeaveNextCursor;

// @ts-expect-error ActionInboxResponse.next_cursor is required even when null.
const missingActionNextCursor: ActionInboxResponse = {
  items: [],
  total: 0,
  total_is_exact: true,
};
void missingActionNextCursor;

type IsNullable<T> = null extends T ? true : false;
type AssertFalse<T extends false> = T;

// Compile-time contract: null is not a valid compatibility projection.
type DaysMustBeNonNullable = AssertFalse<IsNullable<LeaveRequestView["days"]>>;
const daysMustBeNonNullable: DaysMustBeNonNullable = false;
void daysMustBeNonNullable;
