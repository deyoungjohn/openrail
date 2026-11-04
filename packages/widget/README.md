# Browser widget

One script tag, no dependencies. It renders a button; clicking opens the hosted pay
page in a dialog.

```html
<script src="https://pay.example.com/widget.js" data-invoice="c-1"></script>
```

Options:
- `data-invoice` (required): the claim token id.
- `data-pay-url`: the hosted pay origin; defaults to the script's origin.
- `data-label`: button text; defaults to `Pay invoice`.

The dialog closes on Esc, on the close button, on a backdrop click, and when the hosted
page posts `{type: "openrail:payment-complete"}` (or `"openrail:paid"`) from the pay origin.
It is keyboard focusable and restores focus to the button. Styling uses
`--openrail-*` custom properties, no inline styles.
