//! Shared logical live-memory reservations for typed formula input backings.
//! Weights are reproducible safety controls, not physical allocator/RSS bounds.
use crate::{FormulaError, TableData};
use std::ops::Deref;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

/// One immutable-limit pool per root. Replacing the root pool never resets a
/// pool still owned by a cached backing or a lazy row from an earlier root.
#[doc(hidden)]
pub struct SourceBudget {
    limit: usize,
    used: AtomicUsize,
    peak: AtomicUsize,
    total: AtomicUsize,
}
impl SourceBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
        }
    }

    pub fn reserve(self: &Arc<Self>, bytes: usize) -> Result<SourceReservation, FormulaError> {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let next = used
                .checked_add(bytes)
                .filter(|next| *next <= self.limit)
                .ok_or_else(|| {
                    FormulaError::ExecutionLimit(
                        "Formula live source memory weight exceeded".into(),
                    )
                })?;
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Relaxed)
            {
                Ok(_) => {
                    self.peak.fetch_max(next, Ordering::Relaxed);
                    let _ = self
                        .total
                        .try_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                            Some(total.saturating_add(bytes))
                        });
                    return Ok(SourceReservation {
                        budget: Arc::clone(self),
                        bytes,
                    });
                }
                Err(current) => used = current,
            }
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }
    pub fn used(&self) -> usize {
        self.used.load(Ordering::Relaxed)
    }
    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }
    pub fn total(&self) -> usize {
        self.total.load(Ordering::Relaxed)
    }
}

/// A reservation is deliberately not Clone. Share the object which owns it.
#[doc(hidden)]
pub struct SourceReservation {
    budget: Arc<SourceBudget>,
    bytes: usize,
}
impl SourceReservation {
    pub fn uses_budget(&self, budget: &Arc<SourceBudget>) -> bool {
        Arc::ptr_eq(&self.budget, budget)
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}
impl Drop for SourceReservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// Both the four-entry typed LRU and all Row values own this same backing.
/// Eviction releases memory only after the last dependent Row is also gone.
#[doc(hidden)]
pub struct TypedTableBacking {
    pub data: Arc<TableData>,
    reservation: SourceReservation,
}
impl TypedTableBacking {
    pub fn new(data: Arc<TableData>, reservation: SourceReservation) -> Self {
        Self { data, reservation }
    }
    pub fn uses_budget(&self, budget: &Arc<SourceBudget>) -> bool {
        self.reservation.uses_budget(budget)
    }
}
impl Deref for TypedTableBacking {
    type Target = TableData;
    fn deref(&self) -> &Self::Target {
        &self.data
    }
}
