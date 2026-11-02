//! Keyless vault v2 (blueprint §1.5 rule 3): exactly two methods, both parent-only.
//!
//!   forward(token_id, amount, receiver_id, gas_tgas)          -> intents.near::mt_transfer
//!   sign(payload, path, domain_id, gas_tgas)                  -> v1.signer::sign
//!
//! `forward` takes 8–50 Tgas and `sign` up to 280 Tgas; both bounds are checked here.
//! `payload` is the `payload_v2` JSON value (for example `{"Ecdsa":"<hex>"}`) and is forwarded
//! verbatim as `request.payload_v2`, which is the shape the MPC signer accepts (K15).
//!
//! Written against the NEAR host functions (`near-sys`), `no_std`, no allocator and no serde:
//! a global-contract publish burns ~1 NEAR per 10 KB, so every KB costs money.
//! Promises are built with the raw host functions; no `near_sdk::Promise` and no `Self::ext`.
//!
//! Feature `testnet` selects `v1.signer-prod.testnet` instead of `v1.signer`.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(feature = "testnet")]
const SIGNER: &[u8] = b"v1.signer-prod.testnet";
#[cfg(not(feature = "testnet"))]
const SIGNER: &[u8] = b"v1.signer";

const INTENTS: &[u8] = b"intents.near";
const TGAS: u64 = 1_000_000_000_000;
const FORWARD_MIN_TGAS: u64 = 8;
const FORWARD_MAX_TGAS: u64 = 50;
const SIGN_MAX_TGAS: u64 = 280;
const MAX: usize = 4096;

fn skip_ws(json: &[u8], mut i: usize) -> usize {
    while i < json.len() && matches!(json[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// End index (exclusive) of the JSON string starting at `i`.
fn scan_string(json: &[u8], mut i: usize) -> Option<usize> {
    if json.get(i) != Some(&b'"') {
        return None;
    }
    i += 1;
    while i < json.len() {
        match json[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// End index (exclusive) of the JSON value starting at `i`.
fn scan_value(json: &[u8], mut i: usize) -> Option<usize> {
    match *json.get(i)? {
        b'"' => scan_string(json, i),
        open @ (b'{' | b'[') => {
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            while i < json.len() {
                match json[i] {
                    b'"' => {
                        i = scan_string(json, i)?;
                        continue;
                    }
                    c if c == open => depth += 1,
                    c if c == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        _ => {
            while i < json.len()
                && !matches!(json[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
            {
                i += 1;
            }
            Some(i)
        }
    }
}

/// Raw JSON value of a top-level field, so nested keys cannot shadow it.
fn field<'a>(json: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut i = skip_ws(json, 0);
    if json.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    loop {
        i = skip_ws(json, i);
        match *json.get(i)? {
            b'}' => return None,
            b',' => {
                i += 1;
                continue;
            }
            b'"' => {}
            _ => return None,
        }
        let key_end = scan_string(json, i)?;
        if &json[i + 1..key_end - 1] == key {
            let colon = skip_ws(json, key_end);
            if json.get(colon) != Some(&b':') {
                return None;
            }
            let value_start = skip_ws(json, colon + 1);
            let value_end = scan_value(json, value_start)?;
            return Some(&json[value_start..value_end]);
        }
        let colon = skip_ws(json, key_end);
        if json.get(colon) != Some(&b':') {
            return None;
        }
        i = scan_value(json, skip_ws(json, colon + 1))?;
    }
}

/// String field without escapes (account ids, token ids, paths).
fn str_field<'a>(json: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let value = field(json, key)?;
    if value.len() < 2 || value[0] != b'"' || value[value.len() - 1] != b'"' {
        return None;
    }
    let inner = &value[1..value.len() - 1];
    if inner.contains(&b'\\') || inner.contains(&b'"') {
        return None;
    }
    Some(inner)
}

/// Unsigned integer field.
fn u64_field(json: &[u8], key: &[u8]) -> Option<u64> {
    let value = field(json, key)?;
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut n: u64 = 0;
    for &c in value {
        n = n.checked_mul(10)?.checked_add((c - b'0') as u64)?;
    }
    Some(n)
}

/// Object field returned as its raw JSON slice.
fn object_field<'a>(json: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let value = field(json, key)?;
    if value.first() == Some(&b'{') && value.last() == Some(&b'}') {
        Some(value)
    } else {
        None
    }
}

/// The vault account is `<name>.<parent>`; only `<parent>` may call it.
/// This covers claim accounts (`c-<n>.<root>`) and module accounts (`<module>.<root>`).
fn is_parent(current: &[u8], predecessor: &[u8]) -> bool {
    match current.iter().position(|&c| c == b'.') {
        Some(dot) => dot + 1 < current.len() && &current[dot + 1..] == predecessor,
        None => false,
    }
}

fn is_account_id(value: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.')
        })
        && !value.starts_with(b".")
        && !value.ends_with(b".")
        && !value.windows(2).any(|w| w == b"..")
}

/// Intent token ids are not account ids: `nep141:usdc.omft.near`, `nep245:v2_1.omni.hot.tg:…`.
fn is_token_id(value: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.iter().all(|&c| (0x21..=0x7e).contains(&c))
}

fn decimal_u64(mut value: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut i = buf.len();
    if value == 0 {
        i -= 1;
        buf[i] = b'0';
    }
    while value > 0 {
        i -= 1;
        buf[i] = b'0' + (value % 10) as u8;
        value /= 10;
    }
    &buf[i..]
}

fn is_decimal(value: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= 38
        && value.iter().all(u8::is_ascii_digit)
        && value.iter().any(|&c| c != b'0')
}

#[cfg(target_arch = "wasm32")]
mod host {
    use super::*;
    use near_sys as sys;

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }

    fn fail(msg: &str) -> ! {
        unsafe { sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
    }

    fn read<'a>(register: u64, buf: &'a mut [u8]) -> &'a [u8] {
        unsafe {
            let len = sys::register_len(register) as usize;
            if len > buf.len() {
                fail("input too large");
            }
            sys::read_register(register, buf.as_mut_ptr() as u64);
            &buf[..len]
        }
    }

    fn assert_parent() {
        let (mut a, mut b) = ([0u8; 128], [0u8; 128]);
        unsafe {
            sys::current_account_id(0);
            sys::predecessor_account_id(1);
        }
        if !is_parent(read(0, &mut a), read(1, &mut b)) {
            fail("Unauthorized: caller is not parent account");
        }
    }

    /// Appends `parts` to `out` starting at `*len`.
    fn put(out: &mut [u8], len: &mut usize, parts: &[&[u8]]) {
        for p in parts {
            if *len + p.len() > out.len() {
                fail("args too large");
            }
            out[*len..*len + p.len()].copy_from_slice(p);
            *len += p.len();
        }
    }

    fn call(target: &[u8], method: &[u8], args: &[u8], gas: u64) -> u64 {
        let one_yocto: u128 = 1;
        unsafe {
            sys::promise_create(
                target.len() as u64,
                target.as_ptr() as u64,
                method.len() as u64,
                method.as_ptr() as u64,
                args.len() as u64,
                args.as_ptr() as u64,
                &one_yocto as *const u128 as u64,
                gas,
            )
        }
    }

    #[no_mangle]
    pub extern "C" fn forward() {
        assert_parent();
        unsafe { sys::input(2) };
        let mut buf = [0u8; MAX];
        let json = read(2, &mut buf);

        let gas_tgas = u64_field(json, b"gas_tgas").unwrap_or_else(|| fail("gas_tgas required"));
        if !(FORWARD_MIN_TGAS..=FORWARD_MAX_TGAS).contains(&gas_tgas) {
            fail("forward gas out of bounds: 8 to 50 Tgas");
        }

        let token = str_field(json, b"token_id").unwrap_or_else(|| fail("token_id required"));
        let amount = str_field(json, b"amount").unwrap_or_else(|| fail("amount required"));
        let receiver =
            str_field(json, b"receiver_id").unwrap_or_else(|| fail("receiver_id required"));
        if !is_token_id(token) {
            fail("token_id is not a valid intent token id");
        }
        if !is_account_id(receiver) {
            fail("receiver_id is not an account id");
        }
        if !is_decimal(amount) {
            // A zero amount is a valid no-op, but it still has to look like a number.
            if amount == b"0" {
                return;
            }
            fail("amount must be a positive decimal string");
        }

        let mut args = [0u8; 1024];
        let mut n = 0;
        put(
            &mut args,
            &mut n,
            &[
                b"{\"receiver_id\":\"",
                receiver,
                b"\",\"token_id\":\"",
                token,
                b"\",\"amount\":\"",
                amount,
                b"\"}",
            ],
        );
        // Return the mt_transfer promise so its failure is the failure of forward().
        let promise = call(INTENTS, b"mt_transfer", &args[..n], gas_tgas * TGAS);
        unsafe { sys::promise_return(promise) };
    }

    #[no_mangle]
    pub extern "C" fn sign() {
        assert_parent();
        unsafe { sys::input(2) };
        let mut buf = [0u8; MAX];
        let json = read(2, &mut buf);

        let gas_tgas = u64_field(json, b"gas_tgas").unwrap_or_else(|| fail("gas_tgas required"));
        if gas_tgas > SIGN_MAX_TGAS {
            fail("sign gas out of bounds: at most 280 Tgas");
        }

        let payload = object_field(json, b"payload").unwrap_or_else(|| fail("payload required"));
        let path = str_field(json, b"path").unwrap_or_else(|| fail("path required"));
        let domain_id = u64_field(json, b"domain_id").unwrap_or_else(|| fail("domain_id required"));
        if path.is_empty() || path.len() > 64 {
            fail("path must be 1 to 64 bytes");
        }
        let mut domain_buf = [0u8; 20];
        let domain = decimal_u64(domain_id, &mut domain_buf);

        let mut args = [0u8; MAX];
        let mut n = 0;
        put(
            &mut args,
            &mut n,
            &[
                b"{\"request\":{\"payload_v2\":",
                payload,
                b",\"path\":\"",
                path,
                b"\",\"domain_id\":",
                domain,
                b"}}",
            ],
        );
        let promise = call(SIGNER, b"sign", &args[..n], gas_tgas * TGAS);
        unsafe { sys::promise_return(promise) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_string_and_number_fields() {
        let j = br#"{"token_id":"nep141:x.omft.near", "amount" : "12","receiver_id":"a.near","gas_tgas":12}"#;
        assert_eq!(str_field(j, b"token_id"), Some(&b"nep141:x.omft.near"[..]));
        assert_eq!(str_field(j, b"amount"), Some(&b"12"[..]));
        assert_eq!(str_field(j, b"receiver_id"), Some(&b"a.near"[..]));
        assert_eq!(str_field(j, b"missing"), None);
        assert_eq!(u64_field(j, b"gas_tgas"), Some(12));
    }

    #[test]
    fn nested_keys_do_not_shadow_top_level_fields() {
        let j = br#"{"payload":{"domain_id":9,"payload":{"x":1}},"path":"evm-1","domain_id":0,"gas_tgas":100}"#;
        assert_eq!(object_field(j, b"payload"), Some(&br#"{"domain_id":9,"payload":{"x":1}}"#[..]));
        assert_eq!(u64_field(j, b"domain_id"), Some(0));
        assert_eq!(str_field(j, b"path"), Some(&b"evm-1"[..]));
        assert_eq!(u64_field(j, b"gas_tgas"), Some(100));
    }

    #[test]
    fn only_the_parent_passes() {
        assert!(is_parent(b"c-1.owed.near", b"owed.near"));
        assert!(is_parent(b"m-module.owed.near", b"owed.near"));
        assert!(is_parent(b"inv-1.owed.near", b"owed.near"));
        assert!(is_parent(b"vault.owed.near", b"owed.near"));
        assert!(!is_parent(b"inv-1.owed.near", b"holder2.near"));
        assert!(!is_parent(b"inv-1.owed.near", b"owed.near.evil.near"));
        assert!(!is_parent(b"owed", b"owed"));
    }

    #[test]
    fn validates_amounts_and_account_ids() {
        assert!(is_decimal(b"1"));
        assert!(is_decimal(b"2500"));
        assert!(!is_decimal(b"0"));
        assert!(!is_decimal(b"01x"));
        assert!(!is_decimal(b""));

        assert!(is_account_id(b"usdc.omft.near"));
        assert!(is_account_id(b"intents.near"));
        assert!(!is_account_id(b"a..b"));
        assert!(!is_account_id(b".near"));

        assert!(is_token_id(b"nep141:usdc.omft.near"));
        assert!(is_token_id(b"nep245:v2_1.omni.hot.tg:56_0xaf88d065"));
        assert!(!is_token_id(b""));
        assert!(!is_token_id(b"has space"));
    }

    #[test]
    fn formats_domain_ids() {
        let mut buf = [0u8; 20];
        assert_eq!(decimal_u64(0, &mut buf), b"0");
        assert_eq!(decimal_u64(7, &mut buf), b"7");
        assert_eq!(decimal_u64(1234567890, &mut buf), b"1234567890");
        assert_eq!(decimal_u64(u64::MAX, &mut buf), b"18446744073709551615");
    }
}
