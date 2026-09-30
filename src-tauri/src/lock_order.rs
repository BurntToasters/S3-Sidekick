//! Global lock order, checked in debug builds.
//!
//! Outer to inner: `Storage` (the storage gate and `STORAGE_OP_LOCK`, taken
//! by `lock_storage_meta` / `lock_storage_ops`), then `VaultFile` (the
//! cross-process `security.json.lock`), then `S3State` (the connection
//! session), then `KeyState` (the unlocked vault key). A thread may only take
//! a lock ranked after every lock it already holds. The async S3 mutation
//! leases are not ranked: they are awaited, never held under these locks.
//!
// Failure modes this guards, written before the check:
// - A path takes the S3 session and then the storage lock, while another
//   takes them in the documented order; the two deadlock under load.
// - A nested (re-entrant) take of the same std mutex deadlocks silently.
// - A guard dropped out of order leaves a stale rank and fails later,
//   unrelated acquisitions.
// - The check costs anything in release builds.

use std::ops::{Deref, DerefMut};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum LockRank {
    Storage = 1,
    VaultFile = 2,
    S3State = 3,
    KeyState = 4,
}

#[cfg(debug_assertions)]
thread_local! {
    static HELD: std::cell::RefCell<Vec<LockRank>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Proof that the current thread may take a lock of this rank. Create it
/// before blocking on the lock, and keep it for as long as the lock is held.
pub(crate) struct LockOrderToken {
    #[cfg(debug_assertions)]
    rank: LockRank,
}

impl LockOrderToken {
    pub(crate) fn acquire(rank: LockRank) -> Self {
        #[cfg(debug_assertions)]
        HELD.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(innermost) = held.iter().max() {
                assert!(
                    rank > *innermost,
                    "lock order violation: taking {:?} while holding {:?}",
                    rank,
                    innermost
                );
            }
            held.push(rank);
        });
        #[cfg(not(debug_assertions))]
        let _ = rank;
        Self {
            #[cfg(debug_assertions)]
            rank,
        }
    }
}

#[cfg(debug_assertions)]
impl Drop for LockOrderToken {
    fn drop(&mut self) {
        HELD.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(index) = held.iter().rposition(|rank| *rank == self.rank) {
                held.remove(index);
            }
        });
    }
}

/// A `MutexGuard` that also holds its rank in the lock order.
pub(crate) struct OrderedGuard<'a, T> {
    guard: std::sync::MutexGuard<'a, T>,
    _order: LockOrderToken,
}

impl<'a, T> OrderedGuard<'a, T> {
    /// Check the order, then block on the mutex.
    pub(crate) fn lock(
        mutex: &'a std::sync::Mutex<T>,
        rank: LockRank,
    ) -> Result<Self, std::sync::PoisonError<std::sync::MutexGuard<'a, T>>> {
        let order = LockOrderToken::acquire(rank);
        let guard = mutex.lock()?;
        Ok(Self {
            guard,
            _order: order,
        })
    }
}

impl<T> Deref for OrderedGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.guard
    }
}

impl<T> DerefMut for OrderedGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.guard
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_order_is_accepted_and_released() {
        let storage = LockOrderToken::acquire(LockRank::Storage);
        let s3 = LockOrderToken::acquire(LockRank::S3State);
        let key = LockOrderToken::acquire(LockRank::KeyState);
        drop(key);
        drop(s3);
        drop(storage);
        // Nothing held any more: an inner lock alone is fine.
        let _key = LockOrderToken::acquire(LockRank::KeyState);
    }

    #[test]
    #[should_panic(expected = "lock order violation")]
    fn inverted_order_panics() {
        let _s3 = LockOrderToken::acquire(LockRank::S3State);
        let _storage = LockOrderToken::acquire(LockRank::Storage);
    }

    #[test]
    #[should_panic(expected = "lock order violation")]
    fn reentrant_take_panics() {
        let _outer = LockOrderToken::acquire(LockRank::Storage);
        let _inner = LockOrderToken::acquire(LockRank::Storage);
    }

    #[test]
    fn out_of_order_drop_leaves_no_stale_rank() {
        let storage = LockOrderToken::acquire(LockRank::Storage);
        let s3 = LockOrderToken::acquire(LockRank::S3State);
        drop(storage);
        drop(s3);
        let _storage_again = LockOrderToken::acquire(LockRank::Storage);
    }
}
