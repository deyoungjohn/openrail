// GENERATED, do not edit. Source: openrail.modules.json (scripts/gen-modules.ts).
#[cfg(feature = "settle")]
pub mod settle;
#[cfg(any(feature = "checkout", feature = "settle"))]
pub mod payout;

/// Ids of the modules compiled into this build.
pub const ENABLED: &[&str] = &[
    #[cfg(feature = "settle")]
    "settle",
];

/// Registered hook implementations for enabled modules.
pub fn registered() -> Vec<&'static dyn crate::hooks::Hook> {
    vec![
    #[cfg(feature = "settle")]
    &settle::HOOK,
    ]
}
