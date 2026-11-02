//! NFT media: a deterministic SVG invoice card rendered in the contract (no external host).
//!
//! Title `Invoice <number>`, the amount due (USDC base units, 6 decimals, printed with two
//! decimals) and the due date (`YYYY-MM-DD`, UTC). All user text is XML-escaped. The media
//! value is `data:image/svg+xml;base64,<svg>`; the SVG stays under 2 KB for normal inputs.
//!
//! Nothing reads the clock or randomness: the same arguments always produce the same bytes.

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

fn xml_escape(value: &str) -> String {
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

/// The raw SVG markup. Deterministic and escaped.
pub fn invoice_svg(invoice_number: &str, amount_due: u128, due_date: u64) -> String {
    format!(
        concat!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500" role="img">"##,
            r##"<rect width="800" height="500" fill="#0b1020"/>"##,
            r##"<text x="40" y="90" fill="#ffffff" font-family="sans-serif" font-size="34">Invoice {number}</text>"##,
            r##"<text x="40" y="170" fill="#9fb3c8" font-family="sans-serif" font-size="28">{amount}</text>"##,
            r##"<text x="40" y="220" fill="#9fb3c8" font-family="sans-serif" font-size="24">Due {date}</text>"##,
            r##"</svg>"##
        ),
        number = xml_escape(invoice_number),
        amount = format_amount(amount_due),
        date = format_date(due_date),
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

fn base64_encode(bytes: &[u8]) -> String {
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
