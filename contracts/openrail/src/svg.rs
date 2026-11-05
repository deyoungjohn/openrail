//! NFT media: a deterministic SVG invoice card rendered in the contract (no external host).
//!
//! Renders title `Invoice <number>`, status, amount due, amount paid, percent, and due or
//! overdue status dynamically from the claim's current state (Blueprint 4.5 H8). All user
//! text is XML-escaped. The media value is `data:image/svg+xml;base64,<svg>`; the SVG stays
//! under 2 KB for normal inputs.

use crate::types::{Claim, Status};

/// Formats USDC base units (6 decimals) with exactly two decimals. Truncates below a cent.
pub fn format_amount(amount_due: u128) -> String {
    let whole = amount_due / 1_000_000;
    let cents = (amount_due % 1_000_000) / 10_000;
    format!("${whole}.{cents:02}")
}

/// Converts unix seconds to `YYYY-MM-DD` in UTC (Howard Hinnant's civil-from-days).
pub fn format_date(unix_seconds: u64) -> String {
    let (year, month, day) = civil_from_days((unix_seconds / 86_400) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

pub fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(character),
        }
    }
    out
}

pub fn status_text(status: &Status) -> &'static str {
    match status {
        Status::Issued => "Issued",
        Status::PartiallyPaid => "PartiallyPaid",
        Status::Paid => "Paid",
        Status::Cancelled => "Cancelled",
        Status::Closed => "Closed",
    }
}

/// The raw live SVG markup rendered from the claim's current state (Blueprint 4.5 H8).
pub fn invoice_svg_live(
    invoice_number: &str,
    amount_due: u128,
    amount_paid: u128,
    status: &Status,
    due_date: u64,
    now_seconds: u64,
) -> String {
    let percent = if *status == Status::Paid {
        100
    } else {
        amount_paid
            .saturating_mul(100)
            .checked_div(amount_due)
            .unwrap_or(0)
            .min(100)
    };

    let is_open = matches!(status, Status::Issued | Status::PartiallyPaid);
    let is_overdue = is_open && now_seconds > due_date;
    let due_date_str = format_date(due_date);
    let due_label = if is_overdue {
        format!("Overdue (due {due_date_str})")
    } else {
        format!("Due {due_date_str}")
    };

    let status_color = match status {
        Status::Paid => "#10b981",
        Status::PartiallyPaid => "#f59e0b",
        Status::Issued => "#38bdf8",
        Status::Cancelled | Status::Closed => "#94a3b8",
    };
    let due_color = if is_overdue { "#ef4444" } else { "#9fb3c8" };

    format!(
        concat!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500" role="img">"##,
            r##"<rect width="800" height="500" fill="#0b1020"/>"##,
            r##"<text x="40" y="90" fill="#ffffff" font-family="sans-serif" font-size="34">Invoice {number}</text>"##,
            r##"<text x="40" y="160" fill="{status_color}" font-family="sans-serif" font-size="26">Status: {status}</text>"##,
            r##"<text x="40" y="220" fill="#9fb3c8" font-family="sans-serif" font-size="28">{amount}</text>"##,
            r##"<text x="40" y="270" fill="#9fb3c8" font-family="sans-serif" font-size="24">Paid: {paid} ({percent}%)</text>"##,
            r##"<text x="40" y="320" fill="{due_color}" font-family="sans-serif" font-size="24">{due}</text>"##,
            r##"</svg>"##
        ),
        number = xml_escape(invoice_number),
        status_color = status_color,
        status = status_text(status),
        amount = format_amount(amount_due),
        paid = format_amount(amount_paid),
        percent = percent,
        due_color = due_color,
        due = xml_escape(&due_label),
    )
}

/// The raw SVG markup for initial/static parameters. Deterministic and escaped.
pub fn invoice_svg(invoice_number: &str, amount_due: u128, due_date: u64) -> String {
    invoice_svg_live(invoice_number, amount_due, 0, &Status::Issued, due_date, 0)
}

/// Renders the live SVG markup directly from the claim's current state and block timestamp.
pub fn render_claim_svg(claim: &Claim, now_seconds: u64) -> String {
    let invoice_number = claim.token_id.strip_prefix("c-").unwrap_or(&claim.token_id);
    let amount_paid = claim.booked_total.0.saturating_sub(claim.surplus.0);
    invoice_svg_live(
        invoice_number,
        claim.amount_due.0,
        amount_paid,
        &claim.status,
        claim.due_date,
        now_seconds,
    )
}

/// The NEP-177 `media` value: `data:image/svg+xml;base64,<svg>`.
pub fn svg_data_uri(invoice_number: &str, amount_due: u128, due_date: u64) -> String {
    let svg = invoice_svg(invoice_number, amount_due, due_date);
    format!(
        "data:image/svg+xml;base64,{}",
        base64_encode(svg.as_bytes())
    )
}

/// Renders the NEP-177 live media data URI from the claim and block timestamp.
pub fn render_claim_media(claim: &Claim, now_seconds: u64) -> String {
    let svg = render_claim_svg(claim, now_seconds);
    format!(
        "data:image/svg+xml;base64,{}",
        base64_encode(svg.as_bytes())
    )
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(a >> 2) as usize] as char);
        out.push(ALPHABET[(((a & 0b11) << 4) | (b >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b & 0b1111) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(c & 0b111111) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn decode_base64(value: &str) -> Option<Vec<u8>> {
    fn index(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = value.bytes().filter(|byte| *byte != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut buffer = 0u32;
        for (offset, byte) in chunk.iter().enumerate() {
            buffer |= (index(*byte)? as u32) << (18 - 6 * offset);
        }
        out.push((buffer >> 16) as u8);
        if chunk.len() > 2 {
            out.push((buffer >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(buffer as u8);
        }
    }
    Some(out)
}

pub fn decode_svg_data_uri(uri: &str) -> Option<String> {
    let prefix = "data:image/svg+xml;base64,";
    let encoded = uri.strip_prefix(prefix)?;
    let bytes = decode_base64(encoded)?;
    String::from_utf8(bytes).ok()
}
