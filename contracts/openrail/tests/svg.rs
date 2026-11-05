//! NFT media (Blueprint 2.1): deterministic, escaped SVG data URI, under 2 KB.

use openrail::svg::{format_amount, format_date, invoice_svg, svg_data_uri};

#[test]
fn svg_contains_title_amount_and_due_date() {
    let svg = invoice_svg("INV-1", 1_234_500, 1_800_000_000);
    assert!(svg.contains(">Invoice INV-1</text>"));
    assert!(svg.contains(">$1.23</text>"));
    assert!(svg.contains(">Due 2027-01-15</text>"));
    assert!(svg.starts_with("<svg "));
    assert!(svg.ends_with("</svg>"));
}

#[test]
fn svg_escapes_xml_markup() {
    let svg = invoice_svg("INV-<script>alert(\"x\")&'", 1_000_000, 0);
    assert!(
        !svg.contains("<script>"),
        "raw markup must not survive escaping"
    );
    assert!(svg.contains("&lt;script&gt;"));
    assert!(svg.contains("&quot;"));
    assert!(svg.contains("&amp;"));
    assert!(svg.contains("&apos;"));
}

#[test]
fn svg_is_deterministic() {
    let first = invoice_svg("INV-42", 999_999, 1_700_000_000);
    let second = invoice_svg("INV-42", 999_999, 1_700_000_000);
    assert_eq!(first, second);
    assert_eq!(
        svg_data_uri("INV-42", 999_999, 1_700_000_000),
        svg_data_uri("INV-42", 999_999, 1_700_000_000)
    );
}

#[test]
fn svg_under_2kb() {
    assert!(invoice_svg("INV-1", 1_000_000, 1_800_000_000).len() < 2048);
    let long_number = "X".repeat(128);
    assert!(invoice_svg(&long_number, 123_456_789, 1_800_000_000).len() < 2048);
}

#[test]
fn svg_data_uri_is_base64_of_the_svg() {
    let svg = invoice_svg("INV-7", 7_000_000, 1_800_000_000);
    let uri = svg_data_uri("INV-7", 7_000_000, 1_800_000_000);
    let prefix = "data:image/svg+xml;base64,";
    assert!(uri.starts_with(prefix));
    assert_eq!(decode_base64(&uri[prefix.len()..]), svg.as_bytes());
}

#[test]
fn amount_formats_two_decimals() {
    assert_eq!(format_amount(0), "$0.00");
    assert_eq!(format_amount(999_999), "$0.99");
    assert_eq!(format_amount(1_000_000), "$1.00");
    assert_eq!(format_amount(123_456_789), "$123.45");
}

#[test]
fn date_formats_utc() {
    assert_eq!(format_date(0), "1970-01-01");
    assert_eq!(format_date(1_700_000_000), "2023-11-14");
    assert_eq!(format_date(1_800_000_000), "2027-01-15");
}

#[test]
fn svg_live_reflects_status_and_percent() {
    use openrail::svg::invoice_svg_live;
    use openrail::types::Status;

    // 1. Issued (0% paid)
    let svg_issued = invoice_svg_live(
        "INV-1",
        1_000_000,
        0,
        &Status::Issued,
        1_800_000_000,
        1_700_000_000,
    );
    assert!(svg_issued.contains("Status: Issued"));
    assert!(svg_issued.contains("Paid: $0.00 (0%)"));
    assert!(svg_issued.contains("Due 2027-01-15"));
    assert!(!svg_issued.contains("Overdue"));

    // 2. PartiallyPaid (50% paid)
    let svg_partial = invoice_svg_live(
        "INV-1",
        1_000_000,
        500_000,
        &Status::PartiallyPaid,
        1_800_000_000,
        1_700_000_000,
    );
    assert!(svg_partial.contains("Status: PartiallyPaid"));
    assert!(svg_partial.contains("Paid: $0.50 (50%)"));

    // 3. Paid (100% paid)
    let svg_paid = invoice_svg_live(
        "INV-1",
        1_000_000,
        1_000_000,
        &Status::Paid,
        1_800_000_000,
        1_700_000_000,
    );
    assert!(svg_paid.contains("Status: Paid"));
    assert!(svg_paid.contains("Paid: $1.00 (100%)"));
    assert!(!svg_paid.contains("Overdue"));

    // 4. Overdue check: when open and now > due_date
    let svg_overdue = invoice_svg_live(
        "INV-1",
        1_000_000,
        0,
        &Status::Issued,
        1_800_000_000,
        1_850_000_000,
    );
    assert!(svg_overdue.contains("Overdue (due 2027-01-15)"));
}

#[test]
fn decode_svg_data_uri_roundtrip() {
    use openrail::svg::decode_svg_data_uri;

    let svg = invoice_svg("INV-99", 5_000_000, 1_800_000_000);
    let uri = svg_data_uri("INV-99", 5_000_000, 1_800_000_000);
    let decoded = decode_svg_data_uri(&uri).expect("decode uri");
    assert_eq!(decoded, svg);
}

fn decode_base64(value: &str) -> Vec<u8> {
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
            buffer |= (index(*byte).expect("base64 alphabet") as u32) << (18 - 6 * offset);
        }
        out.push((buffer >> 16) as u8);
        if chunk.len() > 2 {
            out.push((buffer >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(buffer as u8);
        }
    }
    out
}
