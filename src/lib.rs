//! Revora Soroban Contracts
//! 
//! This library contains the Soroban smart contracts for the Revora platform.
//! Currently, it includes:
//! - VestingContract: Manages token vesting schedules for beneficiaries.

#![no_std]

mod vesting;

pub use vesting::*;
