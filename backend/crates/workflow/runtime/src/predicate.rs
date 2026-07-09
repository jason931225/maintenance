//! Small, deterministic predicate language for `condition` nodes (BE-AUTO
//! slice 2). Deliberately NOT an expression evaluator: the only shapes are a
//! single field/op/value comparison and `all`/`any` lists of sub-predicates.
//! Evaluated against a run's context payload (a JSON object). Parsing happens
//! once at graph-parse time (fail-closed on malformed authoring); evaluation is
//! then an infallible boolean so the runtime walk cannot error on a branch.
//!
//! Grammar (JSON):
//! ```json
//! { "field": "a.b", "op": "eq|ne|gt|gte|lt|lte|in", "value": <json> }
//! { "all": [ <predicate>, ... ] }   // AND — empty list is vacuously true
//! { "any": [ <predicate>, ... ] }   // OR  — empty list is false
//! ```
//! `field` is a dotted path into the context object. Ordering ops
//! (`gt/gte/lt/lte`) compare numbers only; a non-numeric operand is deterministically
//! unsatisfied (never an error). `in` requires an array `value` and holds when the
//! field equals any element.

use mnt_kernel_core::KernelError;
use serde_json::Value;

/// Guards against a pathological deeply-nested authored predicate. Admin-authored,
/// but still bounded so parse/eval are cheap and stack-safe.
const MAX_DEPTH: usize = 8;

/// A comparison operator over a single context field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
}

impl CmpOp {
    fn parse(raw: &str) -> Result<Self, KernelError> {
        Ok(match raw {
            "eq" => Self::Eq,
            "ne" => Self::Ne,
            "gt" => Self::Gt,
            "gte" => Self::Gte,
            "lt" => Self::Lt,
            "lte" => Self::Lte,
            "in" => Self::In,
            other => {
                return Err(KernelError::validation(format!(
                    "unsupported condition op {other:?} (expected eq/ne/gt/gte/lt/lte/in)"
                )));
            }
        })
    }
}

/// A parsed, deterministic condition predicate.
#[derive(Debug, Clone, PartialEq)]
pub enum Predicate {
    /// `field <op> value` against the run context.
    Cmp {
        field: String,
        op: CmpOp,
        value: Value,
    },
    /// Every sub-predicate must hold (AND). Empty ⇒ true.
    All(Vec<Predicate>),
    /// At least one sub-predicate must hold (OR). Empty ⇒ false.
    Any(Vec<Predicate>),
}

impl Predicate {
    /// Parse a predicate from its authored JSON. Fail-closed on any shape the
    /// grammar does not allow.
    pub fn parse(value: &Value) -> Result<Self, KernelError> {
        Self::parse_at(value, 0)
    }

    fn parse_at(value: &Value, depth: usize) -> Result<Self, KernelError> {
        if depth > MAX_DEPTH {
            return Err(KernelError::validation(
                "condition predicate nesting is too deep",
            ));
        }
        let object = value
            .as_object()
            .ok_or_else(|| KernelError::validation("condition predicate must be a JSON object"))?;

        // Exactly one of all / any / (field+op) must be present.
        if let Some(list) = object.get("all") {
            return Ok(Self::All(Self::parse_list(list, depth)?));
        }
        if let Some(list) = object.get("any") {
            return Ok(Self::Any(Self::parse_list(list, depth)?));
        }

        let field = object
            .get("field")
            .and_then(Value::as_str)
            .filter(|field| !field.trim().is_empty())
            .ok_or_else(|| {
                KernelError::validation("condition predicate requires a non-empty field")
            })?
            .to_owned();
        let op = CmpOp::parse(
            object
                .get("op")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::validation("condition predicate requires an op"))?,
        )?;
        let value = object
            .get("value")
            .cloned()
            .ok_or_else(|| KernelError::validation("condition predicate requires a value"))?;
        if op == CmpOp::In && !value.is_array() {
            return Err(KernelError::validation(
                "condition predicate op \"in\" requires an array value",
            ));
        }
        Ok(Self::Cmp { field, op, value })
    }

    fn parse_list(value: &Value, depth: usize) -> Result<Vec<Predicate>, KernelError> {
        let array = value.as_array().ok_or_else(|| {
            KernelError::validation("condition predicate all/any must be an array")
        })?;
        array
            .iter()
            .map(|item| Self::parse_at(item, depth + 1))
            .collect()
    }

    /// Evaluate this predicate against a run context object. Infallible: an
    /// unresolvable field or a type mismatch is deterministically `false`.
    #[must_use]
    pub fn eval(&self, context: &Value) -> bool {
        match self {
            Self::All(list) => list.iter().all(|p| p.eval(context)),
            Self::Any(list) => list.iter().any(|p| p.eval(context)),
            Self::Cmp { field, op, value } => {
                let actual = lookup(context, field);
                eval_cmp(*op, actual, value)
            }
        }
    }
}

/// Resolve a dotted path (`a.b.c`) against a JSON object. `None` when any
/// segment is missing or a non-object is traversed.
fn lookup<'a>(context: &'a Value, field: &str) -> Option<&'a Value> {
    let mut current = context;
    for segment in field.split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn eval_cmp(op: CmpOp, actual: Option<&Value>, expected: &Value) -> bool {
    match op {
        CmpOp::Eq => actual == Some(expected),
        CmpOp::Ne => actual != Some(expected),
        CmpOp::In => expected
            .as_array()
            .is_some_and(|items| actual.is_some_and(|a| items.iter().any(|item| item == a))),
        CmpOp::Gt | CmpOp::Gte | CmpOp::Lt | CmpOp::Lte => {
            match (actual.and_then(Value::as_f64), expected.as_f64()) {
                (Some(a), Some(b)) => match op {
                    CmpOp::Gt => a > b,
                    CmpOp::Gte => a >= b,
                    CmpOp::Lt => a < b,
                    CmpOp::Lte => a <= b,
                    _ => unreachable!(),
                },
                // Ordering against a non-number is deterministically unsatisfied.
                _ => false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cmp_and_boolean_combinators_evaluate_deterministically() {
        let ctx = json!({ "amount": 1500, "kind": "purchase", "meta": { "urgent": true } });

        // Single comparisons.
        assert!(
            Predicate::parse(&json!({"field":"amount","op":"gt","value":1000}))
                .unwrap()
                .eval(&ctx)
        );
        assert!(
            !Predicate::parse(&json!({"field":"amount","op":"lt","value":1000}))
                .unwrap()
                .eval(&ctx)
        );
        assert!(
            Predicate::parse(&json!({"field":"kind","op":"eq","value":"purchase"}))
                .unwrap()
                .eval(&ctx)
        );
        assert!(
            Predicate::parse(&json!({"field":"kind","op":"in","value":["leave","purchase"]}))
                .unwrap()
                .eval(&ctx)
        );
        assert!(
            Predicate::parse(&json!({"field":"meta.urgent","op":"eq","value":true}))
                .unwrap()
                .eval(&ctx)
        );

        // Missing field / type mismatch is false, never an error.
        assert!(
            !Predicate::parse(&json!({"field":"missing","op":"gt","value":1}))
                .unwrap()
                .eval(&ctx)
        );
        assert!(
            !Predicate::parse(&json!({"field":"kind","op":"gt","value":1}))
                .unwrap()
                .eval(&ctx)
        );

        // all / any.
        let all = Predicate::parse(&json!({"all":[
            {"field":"amount","op":"gte","value":1500},
            {"field":"kind","op":"eq","value":"purchase"}
        ]}))
        .unwrap();
        assert!(all.eval(&ctx));
        let any = Predicate::parse(&json!({"any":[
            {"field":"amount","op":"gt","value":9999},
            {"field":"kind","op":"eq","value":"purchase"}
        ]}))
        .unwrap();
        assert!(any.eval(&ctx));
        // Empty all is true, empty any is false.
        assert!(Predicate::parse(&json!({"all":[]})).unwrap().eval(&ctx));
        assert!(!Predicate::parse(&json!({"any":[]})).unwrap().eval(&ctx));
    }

    #[test]
    fn malformed_predicates_fail_closed_at_parse() {
        assert!(Predicate::parse(&json!("nope")).is_err());
        assert!(Predicate::parse(&json!({"field":"a","op":"weird","value":1})).is_err());
        assert!(Predicate::parse(&json!({"field":"a","op":"eq"})).is_err());
        assert!(Predicate::parse(&json!({"field":"a","op":"in","value":1})).is_err());
    }
}
